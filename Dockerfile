FROM node:20-slim

RUN npm install -g @anthropic-ai/claude-code

# Claude Code refuses --dangerously-skip-permissions when running as root
RUN useradd -m -u 1001 -s /bin/sh claude

# Pre-seed .claude.json to skip the onboarding flow (would hang non-interactively)
RUN echo '{"hasCompletedOnboarding": true}' > /home/claude/.claude.json && \
    mkdir -p /home/claude/.claude && \
    chown -R claude:claude /home/claude/.claude /home/claude/.claude.json

# Entrypoint writes ~/.claude/settings.json from runtime env vars before starting claude
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

WORKDIR /workspace

USER claude

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
