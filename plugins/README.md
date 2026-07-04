# Plugins

Drop JavaScript modules here to extend AI-Orchestrator without touching its
code. Every `<name>.js` file (or `<name>/index.js` folder) in this directory
is loaded at startup.

See [API.md](../API.md#2-plugin-api) for the full plugin contract and the
list of orchestrator events, and `../examples/example-plugin.js` for a
ready-to-copy starting point.

A plugin that throws during load is skipped and logged — it can never take
the supervisor down.
