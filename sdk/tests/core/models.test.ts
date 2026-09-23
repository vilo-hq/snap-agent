import { describe, expect, it } from 'vitest';
import { Models, ModelDisplayNames, displayNameForModel } from '../../src/providers';

const allIds = Object.values(Models).flatMap((byProvider) => Object.values(byProvider));

describe('Models catalog', () => {
  it('has unique ids and UPPER_SNAKE keys', () => {
    expect(new Set(allIds).size).toBe(allIds.length);
    for (const byProvider of Object.values(Models)) {
      for (const key of Object.keys(byProvider)) expect(key).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it('gives every id a display name', () => {
    for (const id of allIds) {
      expect(ModelDisplayNames[id], `display name for ${id}`).toBeTruthy();
      expect(displayNameForModel(id)).toBe(ModelDisplayNames[id]);
    }
    expect(displayNameForModel('some-unlisted-model')).toBe('some-unlisted-model');
  });

  // Retired ids in the catalog become agents that stop answering. Keep them out.
  it('lists no retired or shut-down models', () => {
    const retired = [/^o1-mini$/, /claude-3-5-/, /claude-3-7-/, /-latest$/, /-\d{8}$/, /^gemini-1\.5/, /^gemini-2\.0/];
    for (const id of allIds) for (const pattern of retired) expect(id, `${id} matches ${pattern}`).not.toMatch(pattern);
  });

  it('keeps the ids the server relies on', () => {
    expect(Models.OpenAI.GPT4O).toBe('gpt-4o');
    expect(Models.OpenAI.GPT4O_MINI).toBe('gpt-4o-mini');
    expect(Models.OpenAI.GPT5).toBe('gpt-5');
    expect(Models.Anthropic.CLAUDE_OPUS_5).toBe('claude-opus-5');
    expect(Models.Google.GEMINI_3_8_FLASH).toBe('gemini-3.8-flash');
  });
});
