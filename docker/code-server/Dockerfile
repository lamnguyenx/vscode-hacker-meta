# code-server + Docker CLI image.
#
# code-server drives the host's Docker daemon through a bind-mounted
# /var/run/docker.sock, but codercom/code-server ships no Docker CLI. This adds
# the official docker-ce-cli and docker-compose-plugin on top.
#
# It also installs bach (https://github.com/lamnguyenx/bach), a modular bash
# configuration, into the `coder` user's shell.
#
# Base is pinned to the same codercom/code-server tag used before, so nothing
# else about the workspace changes.
FROM codercom/code-server:4.138.0

# The base image runs as the non-root `coder` user, but apt needs root. Switch
# back at the end to keep the image's default user (compose overrides it anyway).
USER root

ARG DEBIAN_FRONTEND=noninteractive

WORKDIR /

    # apt-fast parallelizes apt downloads via aria2. Its quick-install script is
    # distro-agnostic, unlike the Ubuntu-only `ppa:apt-fast/stable`.
    RUN --mount=type=cache,target=/var/cache/apt \
        --mount=type=cache,target=/var/lib/apt \
        apt-get update && \
        apt-get install -y --no-install-recommends \
            ca-certificates \
            curl \
            wget \
            aria2 && \
        \
        bash -c "$(curl -fsSL https://raw.githubusercontent.com/ilikenwf/apt-fast/master/quick-install.sh)"

    # Add Docker's official Debian repo, then install the CLI + Compose plugin.
    RUN --mount=type=cache,target=/var/cache/apt \
        --mount=type=cache,target=/var/lib/apt \
        install -m 0755 -d /etc/apt/keyrings && \
        \
        curl -fsSL https://download.docker.com/linux/debian/gpg \
            -o /etc/apt/keyrings/docker.asc && \
        chmod a+r /etc/apt/keyrings/docker.asc && \
        \
        . /etc/os-release && \
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" \
            > /etc/apt/sources.list.d/docker.list && \
        \
        apt-fast update && \
        MAXNUM=8 apt-fast install --no-install-recommends -y \
            docker-ce-cli \
            docker-compose-plugin

    # Expose the Compose plugin as the standalone `docker-compose` command too,
    # so both `docker-compose` and `docker compose` work.
    RUN ln -sf /usr/libexec/docker/cli-plugins/docker-compose \
            /usr/local/bin/docker-compose

    # Sanity check at build time so a broken image fails fast.
    RUN docker --version && \
        docker-compose version && \
        docker compose version

USER 1000

ENV HOME=/home/coder

WORKDIR /home/coder

    # bach: modular bash configuration for the `coder` user. Its installer bakes
    # the clone's absolute path into ~/.bashrc, so it must live at a fixed path.
    #
    # BACH_REF is both the git ref to fetch (branch, tag, or commit SHA) and the
    # cache key, so a new value re-clones. Bust the cache with:
    #   docker compose build \
    #       --build-arg BACH_REF=$(git ls-remote https://github.com/lamnguyenx/bach.git HEAD | cut -f1)
    ARG BACH_REF=HEAD

    RUN git init .local/share/bach && \
        cd .local/share/bach && \
            git remote add origin https://github.com/lamnguyenx/bach.git && \
            git fetch --depth 1 origin "${BACH_REF}" && \
            git checkout FETCH_HEAD && \
            \
            bash ./setup.sh && \
        \
        rm -f /home/coder/.bashrc.backup.*
