FROM mcr.microsoft.com/devcontainers/base:bullseye

# Update and install dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    curl \
    lsb-release \
    gnupg \
    ca-certificates \
    software-properties-common \
    apt-transport-https \
    jq \
    shellcheck \
    unzip \
    libc6 \
    &&  rm -rf /var/lib/apt/lists/*

# Install Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g npm@latest

RUN node --version && \
    npm --version

# Install Python 3 and pip
RUN apt-get install -y python3 python3-pip && \
    ln -s /usr/bin/python3 /usr/bin/python && \
    pip3 install --upgrade pip setuptools

RUN python --version && \
    pip --version

# Install Pulumi CLI
RUN curl -fsSL https://get.pulumi.com | sh -s -- --version 3.178.0 && \
    mkdir -p /opt/.pulumi && mv /root/.pulumi/* /opt/.pulumi/ && \
    ln -s /opt/.pulumi/bin/pulumi /usr/local/bin/pulumi

RUN pulumi version

RUN curl -sS https://starship.rs/install.sh | sh -s -- -y