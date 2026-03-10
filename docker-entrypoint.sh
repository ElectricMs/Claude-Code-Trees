#!/bin/sh
set -e

# Write ~/.claude/settings.json at container start time.
# This is the official BigModel configuration method: all Claude Code settings
# (including the API key) live in settings.json, not as raw env vars.
mkdir -p /home/claude/.claude

cat > /home/claude/.claude/settings.json << SETTINGS
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "${ANTHROPIC_API_KEY}",
    "ANTHROPIC_BASE_URL": "${ANTHROPIC_BASE_URL:-https://open.bigmodel.cn/api/anthropic}",
    "API_TIMEOUT_MS": "${API_TIMEOUT_MS:-3000000}",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "${ANTHROPIC_DEFAULT_HAIKU_MODEL:-glm-4.5-air}",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "${ANTHROPIC_DEFAULT_SONNET_MODEL:-glm-4.7}",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "${ANTHROPIC_DEFAULT_OPUS_MODEL:-glm-5}"
  }
}
SETTINGS

exec claude "$@"
