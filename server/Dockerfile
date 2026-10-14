# LeetViz language server with every LeetCode toolchain, in a container.
#
#   docker build -t leetviz-server -f server/Dockerfile .          (from the leetviz/ folder)
#   docker run --rm -p 127.0.0.1:8787:8787 --memory 4g --pids-limit 512 --cpus 2 leetviz-server
#
# The server compiles and runs whatever code the panel sends, so the container is its sandbox:
# keep the port bound to 127.0.0.1 and use the resource limits above.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl bzip2 xz-utils unzip git \
      build-essential gdb python3 python3-dev libpython3.12 \
      binutils gnupg2 libc6-dev libcurl4-openssl-dev libedit2 libncurses-dev libsqlite3-0 \
      libxml2-dev libz3-dev pkg-config tzdata zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash leetviz
USER leetviz
WORKDIR /home/leetviz/leetviz

# tracer.py (Python engine) is shared with the extension, so the server needs engine/ too.
COPY --chown=leetviz engine ./engine
COPY --chown=leetviz server/scripts ./server/scripts
RUN ./server/scripts/install-toolchains.sh
COPY --chown=leetviz server ./server
RUN cd server/langs/js && . ../../.toolchains/env.sh && npm install --omit=dev --no-audit --no-fund

WORKDIR /home/leetviz/leetviz/server
ENV LEETVIZ_WORK=/tmp/leetviz-work
EXPOSE 8787
CMD ["bash", "-c", ". .toolchains/env.sh && exec node index.js --host 0.0.0.0"]
