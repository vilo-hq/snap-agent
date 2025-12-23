# @snap-agent/middleware-moderation

Content moderation middleware for SnapAgent SDK. Provides safety guardrails including PII detection, profanity filtering, and topic blocking.

## Installation

```bash
npm install @snap-agent/middleware-moderation
```

## Quick Start

```typescript
import { createClient } from '@snap-agent/core';
import { ContentModeration } from '@snap-agent/middleware-moderation';

const moderation = new ContentModeration({
  detectPII: {
    enabled: true,
    types: ['email', 'phone', 'ssn', 'credit_card'],
    action: 'mask',
  },
  profanityFilter: {
    enabled: true,
    action: 'mask',
  },
  blockedTopics: {
    enabled: true,
    topics: ['violence', 'illegal'],
    action: 'block',
  },
});

const agent = await client.createAgent({
  plugins: [moderation],
  // ...
});
```

## Features

### PII Detection & Masking

Detects and masks:
- Email addresses
- Phone numbers
- SSN (Social Security Numbers)
- Credit card numbers
- IP addresses
- Physical addresses
- Names

```typescript
new ContentModeration({
  detectPII: {
    enabled: true,
    types: ['email', 'phone', 'ssn', 'credit_card'],
    action: 'mask', // 'block' | 'mask' | 'warn' | 'flag'
  },
});

// Input: "My email is john@example.com and SSN is 123-45-6789"
// Output: "My email is [REDACTED] and SSN is [REDACTED]"
```

### Profanity Filter

```typescript
new ContentModeration({
  profanityFilter: {
    enabled: true,
    action: 'mask',
    customWords: ['badword1', 'badword2'],
    allowList: ['hell'], // Words to allow
  },
});
```

### Topic Blocking

```typescript
new ContentModeration({
  blockedTopics: {
    enabled: true,
    topics: ['violence', 'illegal activities', 'harmful content'],
    action: 'block',
  },
  onBlock: (result, context) => {
    console.log('Blocked:', result.violations);
  },
});
```

### Custom Moderation

```typescript
new ContentModeration({
  customModerator: async (text, direction) => {
    // Call external moderation API
    const result = await yourModerationAPI.check(text);
    return {
      passed: result.safe,
      violations: result.issues.map(i => ({
        type: 'custom',
        text: i.text,
        position: { start: 0, end: 0 },
        action: 'block',
      })),
    };
  },
});
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `detectPII.enabled` | `boolean` | `false` | Enable PII detection |
| `detectPII.types` | `string[]` | all | PII types to detect |
| `detectPII.action` | `string` | `'mask'` | Action on detection |
| `profanityFilter.enabled` | `boolean` | `false` | Enable profanity filter |
| `blockedTopics.topics` | `string[]` | `[]` | Topics to block |
| `moderateInput` | `boolean` | `true` | Check user input |
| `moderateOutput` | `boolean` | `true` | Check agent output |

## Actions

- `block` - Reject the message entirely
- `mask` - Replace sensitive content with [REDACTED]
- `warn` - Allow but log a warning
- `flag` - Allow but add metadata flag

## License

MIT

