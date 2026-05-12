/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

use std::fs;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use crate::auth::Auth;
use crate::constants::{self, AGENT_HOST_PORT};
use crate::log;
use crate::tunnels::agent_host::{AgentHostConfig, AgentHostManager, AgentHostSidecar, LoopbackAuth};
use crate::tunnels::dev_tunnels::DevTunnels;
use crate::tunnels::shutdown_signal::ShutdownRequest;
use crate::update_service::Platform;
use crate::util::errors::{AnyError, CodeError};
use crate::util::http::ReqwestSimpleHttp;
use crate::util::prereqs::PreReqChecker;

use super::args::AgentHostArgs;
use super::output;
use super::tunnels::fulfill_existing_tunnel_args;
use super::CommandContext;

/// Runs a local agent host server. Downloads the latest VS Code server on
/// demand, starts it with `--enable-remote-auto-shutdown`, and proxies
/// WebSocket connections from a local TCP port to the server's agent host
/// socket. The server auto-shuts down when idle; the CLI checks for updates
/// in the background and starts the latest version on the next connection.
pub async fn agent_host(ctx: CommandContext, mut args: AgentHostArgs) -> Result<i32, AnyError> {
	let started = Instant::now();

	let platform: Platform = PreReqChecker::new().verify().await?;

	if !args.without_connection_token {
		if let Some(p) = args.connection_token_file.as_deref() {
			let token = fs::read_to_string(PathBuf::from(p))
				.map_err(CodeError::CouldNotReadConnectionTokenFile)?;
			args.connection_token = Some(token.trim().to_string());
		} else {
			let token_path = ctx.paths.root().join("agent-host-token");
			let token = mint_connection_token(&token_path, args.connection_token.clone())
				.map_err(CodeError::CouldNotCreateConnectionTokenFile)?;
			args.connection_token = Some(token);
			args.connection_token_file = Some(token_path.to_string_lossy().to_string());
		}
	}

	let manager = AgentHostManager::new(
		ctx.log.clone(),
		platform,
		ctx.paths.server_cache.clone(),
		Arc::new(ReqwestSimpleHttp::with_client(ctx.http.clone())),
		AgentHostConfig {
			server_data_dir: args.server_data_dir.clone(),
			// The CLI proxy enforces the connection token itself, so the
			// underlying server always runs without one. This lets tunnel
			// connections (which bypass the proxy token check) reach the
			// server without needing a token at all.
			without_connection_token: true,
			connection_token: None,
			connection_token_file: None,
		},
	);

	// Eagerly resolve the latest version so the first connection is fast.
	// Skip when using a dev override since updates don't apply.
	if option_env!("VSCODE_CLI_OVERRIDE_SERVER_PATH").is_none() {
		match manager.get_latest_release().await {
			Ok(release) => {
				if let Err(e) = manager.ensure_downloaded(&release).await {
					warning!(ctx.log, "Error downloading latest server version: {}", e);
				}
			}
			Err(e) => warning!(ctx.log, "Error resolving initial server version: {}", e),
		}

		// Start background update checker
		let manager_for_updates = manager.clone();
		tokio::spawn(async move {
			manager_for_updates.run_update_loop().await;
		});
	}

	let addr: SocketAddr = match &args.host {
		Some(h) => SocketAddr::new(h.parse().map_err(CodeError::InvalidHostAddress)?, args.port),
		None => SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), args.port),
	};

	let mut pending_tunnel = None;
	let mut tunnel_name: Option<String> = None;
	if args.tunnel {
		let mut auth = Auth::new(&ctx.paths, ctx.log.clone());
		auth.set_provider(crate::auth::AuthProvider::Github);
		let mut dt = DevTunnels::new_remote_tunnel(&ctx.log, auth, &ctx.paths);

		let mut tunnel = if let Some(existing) =
			fulfill_existing_tunnel_args(args.existing_tunnel.clone(), &args.name)
		{
			dt.start_existing_tunnel(existing).await
		} else {
			dt.start_new_launcher_tunnel(args.name.as_deref(), args.random_name, &[])
				.await
		}?;

		tunnel_name = Some(tunnel.name.clone());
		let tunnel_port = tunnel.add_port_direct(AGENT_HOST_PORT).await?;
		pending_tunnel = Some((tunnel, tunnel_port));
	}

	// Bind the public listener and write the lockfile up front; the agent
	// host backend is started lazily by the sidecar's manager on the first
	// request.
	let loopback_auth = match args.connection_token.clone() {
		Some(token) => LoopbackAuth::Token(token),
		None => {
			// Reachable only via `--without-connection-token`; the token-minting
			// branch above always populates `args.connection_token` otherwise.
			LoopbackAuth::Disabled
		}
	};
	let sidecar = AgentHostSidecar::bind_tcp(
		ctx.log.clone(),
		manager,
		addr,
		loopback_auth,
		tunnel_name.clone(),
		ctx.paths.agent_host_lockfile(),
	)
	.await?;
	let bound_addr = sidecar.bound_addr();

	let mut tunnel_handle: Option<crate::tunnels::dev_tunnels::ActiveTunnel> = None;
	if let Some((tunnel, mut tunnel_port)) = pending_tunnel {
		// Receive tunnel connections directly (no TCP forwarding) and serve
		// them through the sidecar without connection-token enforcement —
		// the tunnel relay provides its own authentication.
		let sidecar_for_tunnel = sidecar.clone();
		tokio::spawn(async move {
			while let Some(socket) = tunnel_port.recv().await {
				let sc = sidecar_for_tunnel.clone();
				tokio::spawn(async move {
					sc.serve_tunnel_connection(socket.into_rw()).await;
				});
			}
		});
		tunnel_handle = Some(tunnel);
	}

	let product = constants::QUALITYLESS_PRODUCT_NAME;
	let token_suffix = args
		.connection_token
		.as_deref()
		.map(|t| format!("?tkn={t}"))
		.unwrap_or_default();

	output::print_banner_header(&format!("{product} Agent Host"), started.elapsed());
	if let (Some(base), Some(name)) = (constants::EDITOR_WEB_URL, &tunnel_name) {
		output::print_banner_line("Tunnel", &format!("{base}/agents/tunnel/{name}"));
	}
	output::print_network_lines(bound_addr.port(), addr.ip(), &token_suffix);
	output::print_banner_footer();

	let shutdown = ShutdownRequest::create_rx([ShutdownRequest::CtrlC]);
	let accept_result = sidecar.serve(shutdown).await;

	sidecar.shutdown().await;

	if let Some(mut tunnel) = tunnel_handle.take() {
		tunnel.close().await.ok();
	}

	accept_result?;

	Ok(0)
}

fn mint_connection_token(path: &Path, prefer_token: Option<String>) -> std::io::Result<String> {
	#[cfg(not(windows))]
	use std::os::unix::fs::OpenOptionsExt;

	let mut file_options = fs::OpenOptions::new();
	file_options.create(true);
	file_options.write(true);
	file_options.read(true);
	#[cfg(not(windows))]
	file_options.mode(0o600);
	let mut file = file_options.open(path)?;

	if prefer_token.is_none() {
		let mut token = String::new();
		file.read_to_string(&mut token)?;
		let token = token.trim();
		if !token.is_empty() {
			return Ok(token.to_string());
		}
	}

	file.set_len(0)?;
	let prefer_token = prefer_token.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
	file.write_all(prefer_token.as_bytes())?;
	Ok(prefer_token)
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::fs;

	#[test]
	fn mint_connection_token_generates_and_persists() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("token");

		// First call with no preference generates a UUID and persists it
		let token1 = mint_connection_token(&path, None).unwrap();
		assert!(!token1.is_empty());
		assert_eq!(fs::read_to_string(&path).unwrap(), token1);

		// Second call with no preference reads the existing token
		let token2 = mint_connection_token(&path, None).unwrap();
		assert_eq!(token1, token2);
	}

	#[test]
	fn mint_connection_token_respects_preferred() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("token");

		// Providing a preferred token writes it to the file
		let token = mint_connection_token(&path, Some("my-token".to_string())).unwrap();
		assert_eq!(token, "my-token");
		assert_eq!(fs::read_to_string(&path).unwrap(), "my-token");
	}

	#[test]
	fn mint_connection_token_preferred_overwrites_existing() {
		let dir = tempfile::tempdir().unwrap();
		let path = dir.path().join("token");

		mint_connection_token(&path, None).unwrap();

		// Providing a preference overwrites any existing token
		let token = mint_connection_token(&path, Some("override".to_string())).unwrap();
		assert_eq!(token, "override");
		assert_eq!(fs::read_to_string(&path).unwrap(), "override");
	}
}
