import diagnosticsChannel from 'node:diagnostics_channel';

const compat = diagnosticsChannel as { channel: (name: string) => unknown; tracingChannel?: (name: string) => unknown };

if (typeof compat.tracingChannel !== 'function') {
  compat.tracingChannel = (name: string) => compat.channel(name);
}
