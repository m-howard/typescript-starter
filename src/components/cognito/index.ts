/**
 * AWS Cognito SSO Component - Fronts the reader portal and APIs with corporate SSO.
 *
 * WAF filters traffic; it does not authenticate corporate identity. This component federates the
 * corporate IdP (Entra ID / Okta) into a Cognito user pool and exposes an app client + hosted
 * domain, giving the reader portal and API Gateway a real OIDC identity to gate against. The
 * IdP's group claim is mapped onto a custom attribute so the chat API can resolve per-user groups
 * for the retrieval ACL filter.
 *
 * @example
 * const sso = new SsoUserPoolComponent('portal-sso', {
 *   name: 'docs-portal',
 *   domainPrefix: 'acme-docs',
 *   callbackUrls: ['https://docs.example.com/oauth2/idpresponse'],
 *   idp: { name: 'Entra', type: 'OIDC', details: { ... }, groupsAttribute: 'groups' },
 * });
 */

import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';

/** Federated IdP configuration. */
export interface FederatedIdpArgs {
    /** Provider name as it appears in Cognito (e.g. "Entra", "Okta") */
    name: string;
    /** Provider protocol */
    type: 'OIDC' | 'SAML';
    /** Provider-specific connection details (client id/secret, issuer, or metadata URL) */
    details: pulumi.Input<{ [key: string]: pulumi.Input<string> }>;
    /** IdP claim/attribute carrying the user's group memberships */
    groupsAttribute?: string;
}

/**
 * Arguments for the SSO user pool.
 */
export interface SsoUserPoolArgs {
    /** Logical name for the pool */
    name: pulumi.Input<string>;
    /** Globally-unique hosted-UI domain prefix */
    domainPrefix: pulumi.Input<string>;
    /** OAuth callback URLs (portal + API gateway) */
    callbackUrls: pulumi.Input<string>[];
    /** OAuth sign-out URLs */
    logoutUrls?: pulumi.Input<string>[];
    /** Federated corporate IdP */
    idp: FederatedIdpArgs;
    /** Resource tags */
    tags?: pulumi.Input<{ [key: string]: pulumi.Input<string> }>;
}

/**
 * Cognito SSO ComponentResource: user pool, federated IdP, hosted domain, and app client.
 */
export class SsoUserPoolComponent extends pulumi.ComponentResource {
    public readonly userPool: aws.cognito.UserPool;
    public readonly identityProvider: aws.cognito.IdentityProvider;
    public readonly userPoolClient: aws.cognito.UserPoolClient;
    public readonly domain: aws.cognito.UserPoolDomain;
    public readonly issuerUrl: pulumi.Output<string>;

    constructor(name: string, args: SsoUserPoolArgs, opts?: pulumi.ComponentResourceOptions) {
        super('aws:identity:SsoUserPoolComponent', name, {}, opts);

        const defaultOpts = { parent: this };

        const defaultTags = { ManagedBy: 'Pulumi' };
        const mergedTags = args.tags
            ? pulumi.output(args.tags).apply((userTags) => ({ ...defaultTags, ...userTags }))
            : defaultTags;

        this.userPool = new aws.cognito.UserPool(
            name,
            {
                name: args.name,
                // Users originate in the corporate IdP; disable self sign-up entirely.
                adminCreateUserConfig: { allowAdminCreateUserOnly: true },
                mfaConfiguration: 'OPTIONAL',
                softwareTokenMfaConfiguration: { enabled: true },
                passwordPolicy: {
                    minimumLength: 12,
                    requireLowercase: true,
                    requireUppercase: true,
                    requireNumbers: true,
                    requireSymbols: true,
                },
                schemas: [
                    {
                        name: 'groups',
                        attributeDataType: 'String',
                        mutable: true,
                        stringAttributeConstraints: { minLength: '0', maxLength: '2048' },
                    },
                ],
                tags: mergedTags,
            },
            defaultOpts,
        );

        const attributeMapping: { [key: string]: string } = { email: 'email' };
        if (args.idp.groupsAttribute) {
            attributeMapping['custom:groups'] = args.idp.groupsAttribute;
        }

        this.identityProvider = new aws.cognito.IdentityProvider(
            `${name}-idp`,
            {
                userPoolId: this.userPool.id,
                providerName: args.idp.name,
                providerType: args.idp.type,
                providerDetails: args.idp.details,
                attributeMapping,
            },
            defaultOpts,
        );

        this.domain = new aws.cognito.UserPoolDomain(
            `${name}-domain`,
            { domain: args.domainPrefix, userPoolId: this.userPool.id },
            defaultOpts,
        );

        this.userPoolClient = new aws.cognito.UserPoolClient(
            `${name}-client`,
            {
                name: pulumi.interpolate`${args.name}-client`,
                userPoolId: this.userPool.id,
                generateSecret: true,
                allowedOauthFlowsUserPoolClient: true,
                allowedOauthFlows: ['code'],
                allowedOauthScopes: ['openid', 'email', 'profile'],
                callbackUrls: args.callbackUrls,
                logoutUrls: args.logoutUrls,
                // Force federation through the corporate IdP; no direct Cognito password auth.
                supportedIdentityProviders: [args.idp.name],
                explicitAuthFlows: ['ALLOW_REFRESH_TOKEN_AUTH'],
            },
            { ...defaultOpts, dependsOn: [this.identityProvider] },
        );

        this.issuerUrl = pulumi.interpolate`https://cognito-idp.${aws.config.region}.amazonaws.com/${this.userPool.id}`;

        this.registerOutputs({
            userPool: this.userPool,
            identityProvider: this.identityProvider,
            userPoolClient: this.userPoolClient,
            domain: this.domain,
            issuerUrl: this.issuerUrl,
        });
    }
}

export default SsoUserPoolComponent;
