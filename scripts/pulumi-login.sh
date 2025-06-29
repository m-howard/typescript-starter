#!/usr/bin/env zsh
# Pulumi login helper script for setting state backend

set -e

echo "Select Pulumi backend:"
echo "1) AWS S3"
echo "2) Local filesystem"
read "backend_choice?Enter choice [1-2]: "

if [[ "$backend_choice" == "1" ]]; then
    read "bucket?Enter S3 bucket name for Pulumi state: "
    read "prefix?Enter optional S3 prefix (or leave blank): "
    if [[ -n "$prefix" ]]; then
        pulumi login "s3://$bucket/$prefix"
    else
        pulumi login "s3://$bucket"
    fi
    echo "Pulumi state backend set to S3 bucket: $bucket"
elif [[ "$backend_choice" == "2" ]]; then
    read "dir?Enter local directory for Pulumi state (default: ~/.pulumi-state): "
    dir=${dir:-~/.pulumi-state}
    pulumi login "file://$dir"
    echo "Pulumi state backend set to local directory: $dir"
else
    echo "Invalid choice. Exiting."
    exit 1
fi
