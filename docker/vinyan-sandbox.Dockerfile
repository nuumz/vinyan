# vinyan-sandbox — isolated worker container for L2/L3 tasks.
#
# Two-layer mount strategy:
#   /workspace — read-only bind mount of real project
#   /overlay   — writable tmpdir for mutations
#   /ipc       — IPC channel (intent.json in, result.json + artifacts/ out)
#
# Security: non-root, no capabilities, no network, PID/memory limits.
# Source of truth: spec/tdd.md §11, design/implementation-plan.md §2.1

FROM oven/bun:1-slim

# Install TypeScript compiler for type checking oracle + build tools for native modules
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*
RUN bun add -g typescript

# Create non-root user
RUN groupadd -g 1000 vinyan && \
    useradd -u 1000 -g vinyan -m vinyan

# Create mount points
RUN mkdir -p /workspace /overlay /ipc/artifacts && \
    chown -R vinyan:vinyan /overlay /ipc

# Copy worker entry point
COPY src/orchestrator/worker/worker-entry.ts /app/worker-entry.ts
COPY src/ /app/src/

WORKDIR /app

USER vinyan

# Worker reads intent.json from /ipc, writes result.json + artifacts to /ipc
ENTRYPOINT ["bun", "run", "/app/worker-entry.ts"]
