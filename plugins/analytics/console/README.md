# @snap-agent/analytics-console

Console analytics plugin for SnapAgent SDK - Pretty-print metrics to terminal for debugging.

## Features

- **Pretty Console Output** - Color-coded, formatted logs
- **Three Log Levels** - Minimal, standard, verbose
- **Periodic Summaries** - Automatic stats output
- **Colorful** - Easy to scan terminal output
- **Perfect for Dev** - Quick debugging during development  

## Installation

```bash
npm install @snap-agent/analytics-console @snap-agent/core
```

## Quick Start

```typescript
import { createClient, MemoryStorage } from '@snap-agent/core';
import { ConsoleAnalytics } from '@snap-agent/analytics-console';

const client = createClient({
  storage: new MemoryStorage(),
  providers: {
    openai: { apiKey: process.env.OPENAI_API_KEY! },
  },
});

const agent = await client.createAgent({
  name: 'Debug Demo',
  instructions: 'You are helpful.',
  model: 'gpt-4o',
  userId: 'user-123',
  plugins: [
    new ConsoleAnalytics({
      level: 'verbose',
    }),
  ],
});

// Use the agent - see pretty logs!
```

## Output Examples

### Standard Level
```
[14:32:15.123] [SnapAgent] -> Request agent:abc12345 thread:xyz98765
[14:32:16.456] [SnapAgent] <- Response 1333ms 450 tokens agent:abc12345
```

### Verbose Level
```
[14:32:15.123] [SnapAgent] -> Request agent:abc12345 thread:xyz98765
  Message: Hello, can you help me with...

[14:32:16.456] [SnapAgent] <- Response 1333ms 450 tokens agent:abc12345
  Response: Of course! I'd be happy to help you with...
```

### Error
```
[14:32:17.789] [SnapAgent] x Error rate_limit agent:abc12345
  Message: Rate limit exceeded. Please retry after 60 seconds.
```

### Summary
```
[SnapAgent] Summary
----------------------------------------
  Requests:      25
  Responses:     24
  Errors:        1
  Avg Latency:   892ms
  Avg Tokens:    380
  Total Tokens:  9120
----------------------------------------
```

## Configuration

```typescript
new ConsoleAnalytics({
  // Log level: 'minimal' | 'standard' | 'verbose'
  level: 'standard',

  // Enable colored output
  colors: true,

  // Show timestamps
  timestamps: true,

  // Custom prefix
  prefix: '[SnapAgent]',

  // What to log
  logRequests: true,
  logResponses: true,
  logErrors: true,

  // Print summary every N ms (0 = disabled)
  summaryInterval: 60000, // Every minute
});
```

## Log Levels

### `minimal`
Just counts, no details:
```
[SnapAgent] -> Request
[SnapAgent] <- Response 450ms
```

### `standard` (default)
Includes agent/thread IDs and tokens:
```
[SnapAgent] -> Request agent:abc12345 thread:xyz98765
[SnapAgent] <- Response 450ms 380 tokens agent:abc12345
```

### `verbose`
Full message content:
```
[SnapAgent] -> Request agent:abc12345 thread:xyz98765
  Message: What is the weather like today?

[SnapAgent] <- Response 450ms 380 tokens agent:abc12345
  Response: I don't have access to real-time weather data...
```

## API

### `printSummary()`
Manually print the current summary:
```typescript
const analytics = new ConsoleAnalytics();
// ... use agent ...
analytics.printSummary();
```

### `reset()`
Reset all counters:
```typescript
analytics.reset();
```

### `getStats()`
Get current stats as object:
```typescript
const stats = analytics.getStats();
// { requests: 25, responses: 24, errors: 1, avgLatency: 892, totalTokens: 9120 }
```

### `destroy()`
Clean up (stops summary timer):
```typescript
analytics.destroy();
```

## Color Reference

| Color | Meaning |
|-------|---------|
| Cyan | Requests |
| Green | Successful responses, fast latency (<500ms) |
| Yellow | Medium latency (500-2000ms) |
| Red | Errors, slow latency (>2000ms) |
| Dim | Metadata, IDs |

## Disable Colors

For CI/CD or piping to files:
```typescript
new ConsoleAnalytics({
  colors: false,
});
```

## Use Cases

- **Local Development** - Quick visibility into agent behavior
- **Debugging** - See what's happening in real-time
- **Demos** - Show activity during presentations
- **Learning** - Understand the request/response flow

For production monitoring, use [@snap-agent/analytics](../core) instead.

## License

MIT © ViloTech

