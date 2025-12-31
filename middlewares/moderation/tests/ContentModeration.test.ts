import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContentModeration, ModerationConfig } from '../src/ContentModeration';

describe('ContentModeration', () => {
  describe('constructor', () => {
    it('should create instance with default config', () => {
      const moderation = new ContentModeration();
      expect(moderation).toBeInstanceOf(ContentModeration);
      expect(moderation.name).toBe('content-moderation');
      expect(moderation.type).toBe('middleware');
      expect(moderation.priority).toBe(10);
    });

    it('should accept custom config', () => {
      const moderation = new ContentModeration({
        detectPII: { enabled: true, action: 'mask' },
        profanityFilter: { enabled: true, action: 'block' },
        moderateInput: true,
        moderateOutput: false,
      });
      expect(moderation).toBeInstanceOf(ContentModeration);
    });

    it('should build profanity set with custom words', () => {
      const moderation = new ContentModeration({
        profanityFilter: {
          enabled: true,
          customWords: ['badword'],
        },
      });
      expect(moderation).toBeInstanceOf(ContentModeration);
    });

    it('should respect allowList for profanity', () => {
      const moderation = new ContentModeration({
        profanityFilter: {
          enabled: true,
          allowList: ['damn'], // Remove from default list
        },
      });
      expect(moderation).toBeInstanceOf(ContentModeration);
    });
  });

  // ==========================================================================
  // PII Detection Tests
  // ==========================================================================

  describe('PII detection', () => {
    let moderation: ContentModeration;

    beforeEach(() => {
      moderation = new ContentModeration({
        detectPII: {
          enabled: true,
          types: ['email', 'phone', 'ssn', 'credit_card'],
          action: 'mask',
        },
      });
    });

    it('should detect and mask email addresses', async () => {
      const result = await moderation.check('Contact me at john@example.com');
      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].type).toBe('pii');
      expect(result.violations[0].subType).toBe('email');
      expect(result.moderatedText).toBe('Contact me at [REDACTED]');
    });

    it('should detect and mask phone numbers', async () => {
      const result = await moderation.check('Call me at 555-123-4567');
      expect(result.passed).toBe(false);
      expect(result.violations[0].subType).toBe('phone');
      expect(result.moderatedText).toContain('[REDACTED]');
    });

    it('should detect and mask SSN', async () => {
      const result = await moderation.check('My SSN is 123-45-6789');
      expect(result.passed).toBe(false);
      expect(result.violations[0].subType).toBe('ssn');
    });

    it('should detect and mask credit card numbers', async () => {
      const result = await moderation.check('Card: 4111-1111-1111-1111');
      expect(result.passed).toBe(false);
      expect(result.violations[0].subType).toBe('credit_card');
    });

    it('should detect multiple PII types', async () => {
      const result = await moderation.check(
        'Email: test@test.com, Phone: 555-555-5555'
      );
      expect(result.violations.length).toBeGreaterThanOrEqual(2);
    });

    it('should block when action is block', async () => {
      moderation = new ContentModeration({
        detectPII: {
          enabled: true,
          types: ['email'],
          action: 'block',
        },
      });

      const result = await moderation.check('Email: test@test.com');
      expect(result.violations[0].action).toBe('block');
      expect(result.moderatedText).toBeUndefined();
    });

    it('should support custom PII patterns', async () => {
      moderation = new ContentModeration({
        detectPII: {
          enabled: true,
          types: [],
          customPatterns: [
            { name: 'employee_id', pattern: /EMP-\d{6}/g },
          ],
          action: 'mask',
        },
      });

      const result = await moderation.check('Employee: EMP-123456');
      expect(result.passed).toBe(false);
      expect(result.violations[0].subType).toBe('employee_id');
    });
  });

  // ==========================================================================
  // Profanity Filter Tests
  // ==========================================================================

  describe('profanity filter', () => {
    let moderation: ContentModeration;

    beforeEach(() => {
      moderation = new ContentModeration({
        profanityFilter: {
          enabled: true,
          action: 'mask',
        },
      });
    });

    it('should detect profanity in text', async () => {
      const result = await moderation.check('This is damn annoying');
      expect(result.passed).toBe(false);
      expect(result.violations[0].type).toBe('profanity');
    });

    it('should mask profanity with asterisks', async () => {
      const result = await moderation.check('What the hell');
      expect(result.moderatedText).toContain('****');
    });

    it('should detect custom profanity words', async () => {
      moderation = new ContentModeration({
        profanityFilter: {
          enabled: true,
          customWords: ['customBadWord'],
          action: 'mask',
        },
      });

      const result = await moderation.check('This is a customBadWord test');
      expect(result.passed).toBe(false);
    });

    it('should allow words in allowList', async () => {
      moderation = new ContentModeration({
        profanityFilter: {
          enabled: true,
          allowList: ['damn'],
          action: 'mask',
        },
      });

      const result = await moderation.check('This is damn good');
      // 'damn' should be allowed
      const damnViolation = result.violations.find(
        (v) => v.text.toLowerCase() === 'damn'
      );
      expect(damnViolation).toBeUndefined();
    });

    it('should block when action is block', async () => {
      moderation = new ContentModeration({
        profanityFilter: {
          enabled: true,
          action: 'block',
        },
      });

      const result = await moderation.check('This is damn annoying');
      expect(result.violations[0].action).toBe('block');
    });
  });

  // ==========================================================================
  // Blocked Topics Tests
  // ==========================================================================

  describe('blocked topics', () => {
    let moderation: ContentModeration;

    beforeEach(() => {
      moderation = new ContentModeration({
        blockedTopics: {
          enabled: true,
          topics: ['violence', 'illegal drugs'],
          action: 'block',
        },
      });
    });

    it('should detect blocked topics', async () => {
      const result = await moderation.check('Tell me about violence in movies');
      expect(result.passed).toBe(false);
      expect(result.violations[0].type).toBe('blocked_topic');
      expect(result.violations[0].subType).toBe('violence');
    });

    it('should detect multiple blocked topics', async () => {
      const result = await moderation.check(
        'Topics: violence and illegal drugs'
      );
      expect(result.violations).toHaveLength(2);
    });

    it('should be case-insensitive', async () => {
      const result = await moderation.check('VIOLENCE is bad');
      expect(result.passed).toBe(false);
    });
  });

  // ==========================================================================
  // beforeRequest Tests
  // ==========================================================================

  describe('beforeRequest', () => {
    it('should skip moderation when moderateInput is false', async () => {
      const moderation = new ContentModeration({
        moderateInput: false,
        detectPII: { enabled: true, action: 'block' },
      });

      const result = await moderation.beforeRequest(
        [{ role: 'user', content: 'My email is test@test.com' }],
        { agentId: 'agent-1' }
      );

      expect(result.metadata?.moderation).toBeUndefined();
    });

    it('should block message with PII', async () => {
      const moderation = new ContentModeration({
        detectPII: { enabled: true, types: ['email'], action: 'block' },
      });

      const result = await moderation.beforeRequest(
        [{ role: 'user', content: 'Email me at test@test.com' }],
        { agentId: 'agent-1' }
      );

      expect(result.metadata?.moderation.blocked).toBe(true);
      expect(result.messages[0].content).toBe("I'm unable to process that request.");
    });

    it('should mask PII in message', async () => {
      const moderation = new ContentModeration({
        detectPII: { enabled: true, types: ['email'], action: 'mask' },
      });

      const result = await moderation.beforeRequest(
        [{ role: 'user', content: 'Email me at test@test.com' }],
        { agentId: 'agent-1' }
      );

      expect(result.metadata?.moderation.masked).toBe(true);
      expect(result.messages[0].content).toBe('Email me at [REDACTED]');
    });

    it('should call onBlock callback when content is blocked', async () => {
      const onBlock = vi.fn();
      const moderation = new ContentModeration({
        detectPII: { enabled: true, types: ['email'], action: 'block' },
        onBlock,
      });

      await moderation.beforeRequest(
        [{ role: 'user', content: 'test@test.com' }],
        { agentId: 'agent-1', threadId: 'thread-1' }
      );

      expect(onBlock).toHaveBeenCalled();
      expect(onBlock.mock.calls[0][1].direction).toBe('input');
    });

    it('should pass clean messages through', async () => {
      const moderation = new ContentModeration({
        detectPII: { enabled: true, action: 'block' },
      });

      const result = await moderation.beforeRequest(
        [{ role: 'user', content: 'Hello, how are you?' }],
        { agentId: 'agent-1' }
      );

      expect(result.metadata?.moderation.passed).toBe(true);
      expect(result.messages[0].content).toBe('Hello, how are you?');
    });
  });

  // ==========================================================================
  // afterResponse Tests
  // ==========================================================================

  describe('afterResponse', () => {
    it('should skip moderation when moderateOutput is false', async () => {
      const moderation = new ContentModeration({
        moderateOutput: false,
        profanityFilter: { enabled: true, action: 'mask' },
      });

      const result = await moderation.afterResponse('damn this is good', {
        agentId: 'agent-1',
      });

      expect(result.response).toBe('damn this is good');
    });

    it('should mask profanity in response', async () => {
      const moderation = new ContentModeration({
        profanityFilter: { enabled: true, action: 'mask' },
      });

      const result = await moderation.afterResponse('What the hell happened', {
        agentId: 'agent-1',
      });

      expect(result.metadata?.moderation.masked).toBe(true);
      expect(result.response).not.toContain('hell');
    });

    it('should block response with blocked topics', async () => {
      const moderation = new ContentModeration({
        blockedTopics: {
          enabled: true,
          topics: ['dangerous activities'],
          action: 'block',
        },
      });

      const result = await moderation.afterResponse(
        'Here are some dangerous activities...',
        { agentId: 'agent-1' }
      );

      expect(result.metadata?.moderation.blocked).toBe(true);
      expect(result.response).toBe(
        'I apologize, but I cannot provide that response.'
      );
    });

    it('should preserve metadata from context', async () => {
      const moderation = new ContentModeration({});

      const result = await moderation.afterResponse('Clean response', {
        agentId: 'agent-1',
        metadata: { customField: 'value' },
      });

      expect(result.metadata?.customField).toBe('value');
    });
  });

  // ==========================================================================
  // Custom Moderator Tests
  // ==========================================================================

  describe('custom moderator', () => {
    it('should use custom moderator function', async () => {
      const customModerator = vi.fn().mockResolvedValue({
        passed: false,
        violations: [
          {
            type: 'custom',
            text: 'test',
            position: { start: 0, end: 4 },
            action: 'flag',
          },
        ],
        moderatedText: 'test',
      });

      const moderation = new ContentModeration({
        customModerator,
      });

      const result = await moderation.check('test content');

      expect(customModerator).toHaveBeenCalledWith('test content', 'input');
      expect(result.passed).toBe(false);
    });
  });

  // ==========================================================================
  // check() method Tests
  // ==========================================================================

  describe('check', () => {
    it('should check content without side effects', async () => {
      const moderation = new ContentModeration({
        detectPII: { enabled: true, types: ['email'], action: 'mask' },
      });

      const result = await moderation.check('Email: test@example.com');

      expect(result.passed).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.moderatedText).toBe('Email: [REDACTED]');
    });

    it('should return passed: true for clean content', async () => {
      const moderation = new ContentModeration({
        detectPII: { enabled: true },
        profanityFilter: { enabled: true },
      });

      const result = await moderation.check('Hello, this is clean content.');

      expect(result.passed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Combined Filters Tests
  // ==========================================================================

  describe('combined filters', () => {
    it('should detect multiple violation types', async () => {
      const moderation = new ContentModeration({
        detectPII: { enabled: true, types: ['email'], action: 'mask' },
        profanityFilter: { enabled: true, action: 'mask' },
      });

      const result = await moderation.check(
        'Email test@test.com and damn that was close'
      );

      expect(result.violations.length).toBeGreaterThanOrEqual(2);
      const types = result.violations.map((v) => v.type);
      expect(types).toContain('pii');
      expect(types).toContain('profanity');
    });

    it('should block if any violation has block action', async () => {
      const moderation = new ContentModeration({
        detectPII: { enabled: true, types: ['email'], action: 'mask' },
        blockedTopics: {
          enabled: true,
          topics: ['violence'],
          action: 'block',
        },
      });

      const result = await moderation.check(
        'Email test@test.com about violence'
      );

      expect(result.violations.some((v) => v.action === 'block')).toBe(true);
      expect(result.moderatedText).toBeUndefined(); // Should not mask when blocking
    });
  });
});

