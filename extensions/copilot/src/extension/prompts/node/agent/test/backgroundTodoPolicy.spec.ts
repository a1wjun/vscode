/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, test } from 'vitest';
import { BackgroundTodoDecision, BackgroundTodoProcessor, BackgroundTodoProcessorState, IBackgroundTodoPolicyInput } from '../backgroundTodoProcessor';
import { IBuildPromptContext, IToolCallRound } from '../../../../prompt/common/intents';
import { ToolName } from '../../../../tools/common/toolNames';

function makeRound(id: string, toolName: string = ToolName.ReadFile): IToolCallRound {
	return {
		id,
		response: `response for ${id}`,
		toolInputRetry: 0,
		toolCalls: [{ name: toolName, arguments: '{}', id: `tc-${id}` }],
	};
}

function makeContextRound(id: string): IToolCallRound {
	return makeRound(id, ToolName.ReadFile);
}

function makeMeaningfulRound(id: string): IToolCallRound {
	return makeRound(id, ToolName.ReplaceString);
}

function makePromptContext(opts?: {
	query?: string;
	toolCallRounds?: IToolCallRound[];
}): IBuildPromptContext {
	return {
		query: opts?.query ?? 'fix the bug',
		history: [],
		chatVariables: { hasVariables: () => false } as any,
		toolCallRounds: opts?.toolCallRounds,
	};
}

function makeInput(overrides?: Partial<IBackgroundTodoPolicyInput>): IBackgroundTodoPolicyInput {
	return {
		backgroundTodoAgentEnabled: true,
		todoToolExplicitlyEnabled: false,
		isAgentPrompt: true,
		promptContext: makePromptContext({ toolCallRounds: [makeMeaningfulRound('r1')] }),
		...overrides,
	};
}

describe('BackgroundTodoProcessor.shouldRun (policy)', () => {

	// ── Hard gates ──────────────────────────────────────────────

	test('returns Skip when experiment is disabled', () => {
		const processor = new BackgroundTodoProcessor();
		const result = processor.shouldRun(makeInput({ backgroundTodoAgentEnabled: false }));
		expect(result.decision).toBe(BackgroundTodoDecision.Skip);
		expect(result.reason).toBe('experimentDisabled');
		expect(result.delta).toBeUndefined();
	});

	test('returns Skip when todo tool is explicitly enabled', () => {
		const processor = new BackgroundTodoProcessor();
		const result = processor.shouldRun(makeInput({ todoToolExplicitlyEnabled: true }));
		expect(result.decision).toBe(BackgroundTodoDecision.Skip);
		expect(result.reason).toBe('todoToolExplicitlyEnabled');
	});

	test('returns Skip for non-agent prompt', () => {
		const processor = new BackgroundTodoProcessor();
		const result = processor.shouldRun(makeInput({ isAgentPrompt: false }));
		expect(result.decision).toBe(BackgroundTodoDecision.Skip);
		expect(result.reason).toBe('nonAgentPrompt');
	});

	test('returns Skip when there is no delta', () => {
		const processor = new BackgroundTodoProcessor();
		processor.deltaTracker.markRoundsProcessed(['r1']);
		const result = processor.shouldRun(makeInput());
		expect(result.decision).toBe(BackgroundTodoDecision.Skip);
		expect(result.reason).toBe('noDelta');
	});

	test('returns Wait when processor is already InProgress', async () => {
		const processor = new BackgroundTodoProcessor();
		const dummyMeta = { newRoundCount: 1, newToolCallCount: 1, substantiveToolCallCount: 1, isInitialDelta: true, isRequestOnly: false };
		processor.start(
			{ userRequest: 'old', newRounds: [makeMeaningfulRound('r0')], history: [], sessionResource: undefined, metadata: dummyMeta },
			async () => {
				await new Promise(resolve => setTimeout(resolve, 200));
				return { outcome: 'success' };
			}
		);
		expect(processor.state).toBe(BackgroundTodoProcessorState.InProgress);

		const result = processor.shouldRun(makeInput({
			promptContext: makePromptContext({ toolCallRounds: [makeMeaningfulRound('r1')] }),
		}));
		expect(result.decision).toBe(BackgroundTodoDecision.Wait);
		expect(result.reason).toBe('processorInProgress');
		expect(result.delta).toBeDefined();

		processor.cancel();
	});

	// ── Initial request ─────────────────────────────────────────

	test('initial request-only delta waits for tool activity before creating plan', () => {
		const processor = new BackgroundTodoProcessor();
		const result = processor.shouldRun(makeInput({
			promptContext: makePromptContext({ query: 'build an app' }),
		}));
		expect(result.decision).toBe(BackgroundTodoDecision.Wait);
		expect(result.reason).toBe('initialPlanNeeded');
		expect(result.delta!.metadata.isInitialDelta).toBe(true);
		expect(result.delta!.metadata.isRequestOnly).toBe(true);
	});

	test('initial request-only delta waits even when todoListExists is true', () => {
		const processor = new BackgroundTodoProcessor();
		const result = processor.shouldRun(makeInput({
			promptContext: makePromptContext({ query: 'build an app' }),
			todoListExists: true,
		}));
		expect(result.decision).toBe(BackgroundTodoDecision.Wait);
		expect(result.reason).toBe('initialPlanNeeded');
	});

	test('skips when processor has already created todos and no new activity', async () => {
		const processor = new BackgroundTodoProcessor();
		const dummyMeta = { newRoundCount: 1, newToolCallCount: 1, substantiveToolCallCount: 1, isInitialDelta: true, isRequestOnly: false };
		// Simulate a successful pass
		processor.start(
			{ userRequest: 'old', newRounds: [makeMeaningfulRound('r0')], history: [], sessionResource: undefined, metadata: dummyMeta },
			async () => ({ outcome: 'success' })
		);
		await processor.waitForCompletion();
		expect(processor.hasCreatedTodos).toBe(true);

		// No new rounds → delta tracker returns undefined → noDelta
		const result = processor.shouldRun(makeInput({
			promptContext: makePromptContext({ query: 'build an app' }),
		}));
		expect(result.decision).toBe(BackgroundTodoDecision.Skip);
		expect(result.reason).toBe('noDelta');
	});

	// ── First-pass fast path ────────────────────────────────────

	test('runs on first substantive call when no todos exist yet (initialActivity)', () => {
		const processor = new BackgroundTodoProcessor();
		const result = processor.shouldRun(makeInput({
			promptContext: makePromptContext({ toolCallRounds: [makeMeaningfulRound('r1')] }),
		}));
		expect(result.decision).toBe(BackgroundTodoDecision.Run);
		expect(result.reason).toBe('initialActivity');
	});

	test('runs on first read-only call when no todos exist yet (exploration counts)', () => {
		const processor = new BackgroundTodoProcessor();
		// A pure-exploration session with a single read should still fire the
		// first pass — the agent has done substantive work even if it hasn't
		// mutated anything yet.
		const result = processor.shouldRun(makeInput({
			promptContext: makePromptContext({ toolCallRounds: [makeContextRound('r1')] }),
		}));
		expect(result.decision).toBe(BackgroundTodoDecision.Run);
		expect(result.reason).toBe('initialActivity');
	});

	test('waits when delta contains only excluded tools (excluded calls do not count)', () => {
		const processor = new BackgroundTodoProcessor();
		const round: IToolCallRound = {
			id: 'r1', response: '', toolInputRetry: 0,
			toolCalls: [{ name: ToolName.CoreManageTodoList, arguments: '{}', id: 'tc-1' }],
		};
		const result = processor.shouldRun(makeInput({
			promptContext: makePromptContext({ toolCallRounds: [round] }),
		}));
		// Excluded-only delta has 0 substantive calls → wait.
		expect(result.decision).toBe(BackgroundTodoDecision.Wait);
		expect(result.reason).toBe('belowThreshold');
	});

	// ── Subsequent passes ───────────────────────────────────────

	test('after first pass, waits until subsequent threshold is met', async () => {
		const processor = new BackgroundTodoProcessor();
		const dummyMeta = { newRoundCount: 1, newToolCallCount: 1, substantiveToolCallCount: 1, isInitialDelta: true, isRequestOnly: false };
		// Simulate a successful first pass so hasCreatedTodos becomes true.
		processor.start(
			{ userRequest: 'old', newRounds: [makeMeaningfulRound('r0')], history: [], sessionResource: undefined, metadata: dummyMeta },
			async () => ({ outcome: 'success' })
		);
		await processor.waitForCompletion();
		expect(processor.hasCreatedTodos).toBe(true);

		// 2 substantive calls — below subsequent threshold of 3.
		const result1 = processor.shouldRun(makeInput({
			promptContext: makePromptContext({ toolCallRounds: [makeContextRound('r1'), makeContextRound('r2')] }),
		}));
		expect(result1.decision).toBe(BackgroundTodoDecision.Wait);
		expect(result1.reason).toBe('belowThreshold');

		// 3 substantive calls — meets subsequent threshold.
		const result2 = processor.shouldRun(makeInput({
			promptContext: makePromptContext({ toolCallRounds: [makeContextRound('r1'), makeContextRound('r2'), makeMeaningfulRound('r3')] }),
		}));
		expect(result2.decision).toBe(BackgroundTodoDecision.Run);
		expect(result2.reason).toBe('substantiveActivity');
	});

	test('subsequent threshold is met by any mix of substantive calls', async () => {
		const processor = new BackgroundTodoProcessor();
		const dummyMeta = { newRoundCount: 1, newToolCallCount: 1, substantiveToolCallCount: 1, isInitialDelta: true, isRequestOnly: false };
		processor.start(
			{ userRequest: 'old', newRounds: [makeMeaningfulRound('r0')], history: [], sessionResource: undefined, metadata: dummyMeta },
			async () => ({ outcome: 'success' })
		);
		await processor.waitForCompletion();

		const round: IToolCallRound = {
			id: 'r1', response: '', toolInputRetry: 0,
			toolCalls: [
				{ name: ToolName.ReadFile, arguments: '{}', id: 'tc-1' },
				{ name: ToolName.FindTextInFiles, arguments: '{}', id: 'tc-2' },
				{ name: ToolName.ReplaceString, arguments: '{}', id: 'tc-3' },
			],
		};
		const result = processor.shouldRun(makeInput({
			promptContext: makePromptContext({ toolCallRounds: [round] }),
		}));
		expect(result.decision).toBe(BackgroundTodoDecision.Run);
		expect(result.reason).toBe('substantiveActivity');
	});

	// ── Metadata ────────────────────────────────────────────────

	test('delta from shouldRun contains substantive count and excludes infrastructure tools', () => {
		const processor = new BackgroundTodoProcessor();
		const round: IToolCallRound = {
			id: 'r1', response: '', toolInputRetry: 0,
			toolCalls: [
				{ name: ToolName.ReadFile, arguments: '{}', id: 'tc-1' },
				{ name: ToolName.ReplaceString, arguments: '{}', id: 'tc-2' },
				{ name: ToolName.CoreManageTodoList, arguments: '{}', id: 'tc-3' }, // excluded
			],
		};
		const result = processor.shouldRun(makeInput({
			promptContext: makePromptContext({ toolCallRounds: [round] }),
		}));
		expect(result.delta!.metadata.substantiveToolCallCount).toBe(2);
		expect(result.delta!.metadata.newToolCallCount).toBe(2); // excluded not counted
	});

	test('shouldRun does not advance the delta cursor', () => {
		const processor = new BackgroundTodoProcessor();
		const input = makeInput({
			promptContext: makePromptContext({ toolCallRounds: [makeMeaningfulRound('r1'), makeMeaningfulRound('r2'), makeMeaningfulRound('r3')] }),
		});
		const result1 = processor.shouldRun(input);
		const result2 = processor.shouldRun(input);
		expect(result1.decision).toBe(BackgroundTodoDecision.Run);
		expect(result2.decision).toBe(BackgroundTodoDecision.Run);
		expect(result2.delta!.newRounds).toHaveLength(3);
	});

	// ── hasCreatedTodos tracking ────────────────────────────────

	test('hasCreatedTodos is false initially', () => {
		const processor = new BackgroundTodoProcessor();
		expect(processor.hasCreatedTodos).toBe(false);
	});

	test('hasCreatedTodos becomes true after successful pass', async () => {
		const processor = new BackgroundTodoProcessor();
		const dummyMeta = { newRoundCount: 1, newToolCallCount: 1, substantiveToolCallCount: 1, isInitialDelta: true, isRequestOnly: false };
		processor.start(
			{ userRequest: 'test', newRounds: [makeMeaningfulRound('r1')], history: [], sessionResource: undefined, metadata: dummyMeta },
			async () => ({ outcome: 'success' })
		);
		await processor.waitForCompletion();
		expect(processor.hasCreatedTodos).toBe(true);
	});

	test('hasCreatedTodos stays false after noop pass', async () => {
		const processor = new BackgroundTodoProcessor();
		const dummyMeta = { newRoundCount: 1, newToolCallCount: 1, substantiveToolCallCount: 1, isInitialDelta: true, isRequestOnly: false };
		processor.start(
			{ userRequest: 'test', newRounds: [makeMeaningfulRound('r1')], history: [], sessionResource: undefined, metadata: dummyMeta },
			async () => ({ outcome: 'noop' })
		);
		await processor.waitForCompletion();
		expect(processor.hasCreatedTodos).toBe(false);
	});
});
