# The self-hosted runner image, as built for the fleet.
#
# Scanned by the images collector: the base image and each tool pin below are declared
# in maintenance.config.yaml so drift in any of them becomes a finding. A tool installed
# here without a matching pin in that file is invisible to the scan, which is why an
# undeclared base image raises a config-stale finding.

FROM ghcr.io/actions/actions-runner:2.321.0

USER root

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    gnupg \
    jq \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Node.js, from NodeSource. The major is the pin; patch releases arrive with the distro.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# kubectl, for jobs that talk to the cluster they run in.
RUN curl -fsSLo /usr/local/bin/kubectl \
    https://dl.k8s.io/release/v1.31.3/bin/linux/amd64/kubectl && \
    chmod +x /usr/local/bin/kubectl

# Helm, for chart-deploying jobs.
RUN curl -fsSL https://get.helm.sh/helm-v3.16.3-linux-amd64.tar.gz \
    | tar -xz --strip-components=1 -C /usr/local/bin linux-amd64/helm

# AWS CLI, for jobs that assume a role in the account.
RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64-2.22.35.zip" -o /tmp/awscli.zip && \
    unzip -q /tmp/awscli.zip -d /tmp && \
    /tmp/aws/install && \
    rm -rf /tmp/awscli.zip /tmp/aws

USER runner
