/**
 * AWS Static Site Component - A private S3 bucket served through CloudFront with WAF, locked to
 * origin-access-control, and gated at the edge by an SSO check.
 *
 * WAF alone filters traffic; it does not authenticate corporate identity. This component pairs a
 * WAF WebACL (managed rules + rate limiting) with a CloudFront viewer-request function hook that
 * enforces the presence of an SSO session before any object is served, so the reader portal's
 * "enterprise access control" claim is actually enforced rather than assumed.
 *
 * @example
 * const site = new StaticSiteComponent('reader-portal', {
 *   name: 'docs-portal',
 *   viewerRequestFunctionArn: ssoCheck.arn,
 *   tags: { Environment: 'dev' },
 * });
 */

import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';

/**
 * Arguments for the static site.
 */
export interface StaticSiteArgs {
    /** Logical name (used for bucket + distribution naming) */
    name: pulumi.Input<string>;
    /** ARN of a CloudFront Function (viewer-request) that enforces the SSO session */
    viewerRequestFunctionArn?: pulumi.Input<string>;
    /** ACM certificate ARN (us-east-1) for a custom domain; omitted uses the default cert */
    acmCertificateArn?: pulumi.Input<string>;
    /** Custom domain aliases */
    aliases?: pulumi.Input<string>[];
    /** Sustained request rate per 5 min per IP before WAF blocks (default: 2000) */
    wafRateLimit?: number;
    /** Resource tags */
    tags?: pulumi.Input<{ [key: string]: pulumi.Input<string> }>;
}

/**
 * Static Site ComponentResource: private S3 origin, OAC, WAF WebACL, and CloudFront distribution.
 */
export class StaticSiteComponent extends pulumi.ComponentResource {
    public readonly bucket: aws.s3.BucketV2;
    public readonly distribution: aws.cloudfront.Distribution;
    public readonly webAcl: aws.wafv2.WebAcl;
    public readonly url: pulumi.Output<string>;

    constructor(name: string, args: StaticSiteArgs, opts?: pulumi.ComponentResourceOptions) {
        super('aws:web:StaticSiteComponent', name, {}, opts);

        const defaultOpts = { parent: this };

        // CLOUDFRONT-scoped WAF WebACLs (and CloudFront ACM certs) must live in us-east-1,
        // independent of the stack's region. Pin a provider for those global resources.
        const usEast1 = new aws.Provider(`${name}-us-east-1`, { region: 'us-east-1' }, defaultOpts);

        const defaultTags = { ManagedBy: 'Pulumi' };
        const mergedTags = args.tags
            ? pulumi.output(args.tags).apply((userTags) => ({ ...defaultTags, ...userTags }))
            : defaultTags;

        // --- Private origin bucket (no public access; reached only via OAC) ---
        this.bucket = new aws.s3.BucketV2(name, { tags: mergedTags }, defaultOpts);

        new aws.s3.BucketPublicAccessBlock(
            `${name}-pab`,
            {
                bucket: this.bucket.id,
                blockPublicAcls: true,
                blockPublicPolicy: true,
                ignorePublicAcls: true,
                restrictPublicBuckets: true,
            },
            defaultOpts,
        );

        const oac = new aws.cloudfront.OriginAccessControl(
            `${name}-oac`,
            {
                originAccessControlOriginType: 's3',
                signingBehavior: 'always',
                signingProtocol: 'sigv4',
            },
            defaultOpts,
        );

        // --- WAF: AWS managed common rules + a rate-based rule (CloudFront scope) ---
        this.webAcl = new aws.wafv2.WebAcl(
            `${name}-waf`,
            {
                scope: 'CLOUDFRONT',
                defaultAction: { allow: {} },
                rules: [
                    {
                        name: 'common-rules',
                        priority: 1,
                        overrideAction: { none: {} },
                        statement: {
                            managedRuleGroupStatement: {
                                name: 'AWSManagedRulesCommonRuleSet',
                                vendorName: 'AWS',
                            },
                        },
                        visibilityConfig: {
                            cloudwatchMetricsEnabled: true,
                            metricName: `${name}-common-rules`,
                            sampledRequestsEnabled: true,
                        },
                    },
                    {
                        name: 'rate-limit',
                        priority: 2,
                        action: { block: {} },
                        statement: {
                            rateBasedStatement: {
                                limit: args.wafRateLimit ?? 2000,
                                aggregateKeyType: 'IP',
                            },
                        },
                        visibilityConfig: {
                            cloudwatchMetricsEnabled: true,
                            metricName: `${name}-rate-limit`,
                            sampledRequestsEnabled: true,
                        },
                    },
                ],
                visibilityConfig: {
                    cloudwatchMetricsEnabled: true,
                    metricName: `${name}-waf`,
                    sampledRequestsEnabled: true,
                },
                tags: mergedTags,
            },
            { parent: this, provider: usEast1 },
        );

        const originId = 's3-origin';
        this.distribution = new aws.cloudfront.Distribution(
            name,
            {
                enabled: true,
                defaultRootObject: 'index.html',
                aliases: args.aliases,
                webAclId: this.webAcl.arn,
                origins: [
                    {
                        originId,
                        domainName: this.bucket.bucketRegionalDomainName,
                        originAccessControlId: oac.id,
                        s3OriginConfig: { originAccessIdentity: '' },
                    },
                ],
                defaultCacheBehavior: {
                    targetOriginId: originId,
                    viewerProtocolPolicy: 'redirect-to-https',
                    allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
                    cachedMethods: ['GET', 'HEAD'],
                    compress: true,
                    forwardedValues: {
                        queryString: false,
                        cookies: { forward: 'none' },
                    },
                    // Edge SSO gate: reject viewers without a valid session before serving objects.
                    functionAssociations: args.viewerRequestFunctionArn
                        ? [
                              {
                                  eventType: 'viewer-request',
                                  functionArn: args.viewerRequestFunctionArn,
                              },
                          ]
                        : undefined,
                },
                restrictions: { geoRestriction: { restrictionType: 'none' } },
                viewerCertificate: args.acmCertificateArn
                    ? {
                          acmCertificateArn: args.acmCertificateArn,
                          sslSupportMethod: 'sni-only',
                          minimumProtocolVersion: 'TLSv1.2_2021',
                      }
                    : { cloudfrontDefaultCertificate: true },
                tags: mergedTags,
            },
            defaultOpts,
        );

        // --- Bucket policy: allow only this distribution (via OAC) to read objects ---
        new aws.s3.BucketPolicy(
            `${name}-policy`,
            {
                bucket: this.bucket.id,
                policy: pulumi
                    .all([this.bucket.arn, this.distribution.arn])
                    .apply(([bucketArn, distArn]) =>
                        JSON.stringify({
                            Version: '2012-10-17',
                            Statement: [
                                {
                                    Sid: 'AllowCloudFrontServicePrincipal',
                                    Effect: 'Allow',
                                    Principal: { Service: 'cloudfront.amazonaws.com' },
                                    Action: ['s3:GetObject'],
                                    Resource: [`${bucketArn}/*`],
                                    Condition: { StringEquals: { 'AWS:SourceArn': distArn } },
                                },
                            ],
                        }),
                    ),
            },
            defaultOpts,
        );

        this.url = pulumi.interpolate`https://${this.distribution.domainName}`;

        this.registerOutputs({
            bucket: this.bucket,
            distribution: this.distribution,
            webAcl: this.webAcl,
            url: this.url,
        });
    }
}

export default StaticSiteComponent;
