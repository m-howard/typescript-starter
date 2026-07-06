/**
 * AWS HTTP API Component - An API Gateway v2 HTTP API fronting a Lambda, gated by a Cognito JWT
 * authorizer and throttled per stage.
 *
 * Both the chat/retrieve API and the writer proxy must require a valid SSO token — an open
 * endpoint is a data-exposure and PR-spam vector. This component wires a JWT authorizer to the
 * Cognito user pool and applies default throttling so a single caller cannot run up cost or spam
 * the writer proxy. Routes default to requiring authorization.
 *
 * @example
 * const api = new HttpApiComponent('chat-api', {
 *   name: 'chat-api',
 *   lambdaArn: chatFn.arn,
 *   lambdaName: chatFn.function.name,
 *   jwt: { issuer: sso.issuerUrl, audiences: [sso.userPoolClient.id] },
 *   routes: [{ routeKey: 'POST /chat' }],
 *   throttle: { rateLimit: 20, burstLimit: 40 },
 * });
 */

import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';

/** JWT authorizer configuration bound to a Cognito user pool. */
export interface JwtAuthorizerArgs {
    /** Token issuer URL (Cognito user pool issuer) */
    issuer: pulumi.Input<string>;
    /** Accepted audiences (Cognito app client IDs) */
    audiences: pulumi.Input<string>[];
}

/** A single route definition. */
export interface RouteArgs {
    /** Route key, e.g. "POST /chat" */
    routeKey: string;
    /** Set false to expose the route without authorization (default: true) */
    authorized?: boolean;
}

/** Per-stage throttling limits. */
export interface ThrottleArgs {
    /** Steady-state requests/sec */
    rateLimit: number;
    /** Burst capacity */
    burstLimit: number;
}

/**
 * Arguments for the HTTP API component.
 */
export interface HttpApiArgs {
    /** Name of the API */
    name: pulumi.Input<string>;
    /** ARN of the backing Lambda */
    lambdaArn: pulumi.Input<string>;
    /** Name of the backing Lambda (for the invoke permission) */
    lambdaName: pulumi.Input<string>;
    /** JWT authorizer configuration */
    jwt: JwtAuthorizerArgs;
    /** Routes to expose */
    routes: RouteArgs[];
    /** Per-stage throttling (protects cost + abuse) */
    throttle?: ThrottleArgs;
    /** Allowed CORS origins for the browser chat UI */
    corsOrigins?: pulumi.Input<string>[];
    /** Resource tags */
    tags?: pulumi.Input<{ [key: string]: pulumi.Input<string> }>;
}

/**
 * HTTP API ComponentResource: API, JWT authorizer, Lambda integration, routes, and stage.
 */
export class HttpApiComponent extends pulumi.ComponentResource {
    public readonly api: aws.apigatewayv2.Api;
    public readonly authorizer: aws.apigatewayv2.Authorizer;
    public readonly stage: aws.apigatewayv2.Stage;
    public readonly endpoint: pulumi.Output<string>;

    constructor(name: string, args: HttpApiArgs, opts?: pulumi.ComponentResourceOptions) {
        super('aws:api:HttpApiComponent', name, {}, opts);

        const defaultOpts = { parent: this };

        const defaultTags = { ManagedBy: 'Pulumi' };
        const mergedTags = args.tags
            ? pulumi.output(args.tags).apply((userTags) => ({ ...defaultTags, ...userTags }))
            : defaultTags;

        this.api = new aws.apigatewayv2.Api(
            name,
            {
                name: args.name,
                protocolType: 'HTTP',
                corsConfiguration: args.corsOrigins
                    ? {
                          allowOrigins: args.corsOrigins,
                          allowMethods: ['POST', 'GET', 'OPTIONS'],
                          allowHeaders: ['authorization', 'content-type'],
                          maxAge: 300,
                      }
                    : undefined,
                tags: mergedTags,
            },
            defaultOpts,
        );

        this.authorizer = new aws.apigatewayv2.Authorizer(
            `${name}-jwt`,
            {
                apiId: this.api.id,
                authorizerType: 'JWT',
                identitySources: ['$request.header.Authorization'],
                name: pulumi.interpolate`${args.name}-jwt`,
                jwtConfiguration: {
                    issuer: args.jwt.issuer,
                    audiences: args.jwt.audiences,
                },
            },
            defaultOpts,
        );

        const integration = new aws.apigatewayv2.Integration(
            `${name}-integration`,
            {
                apiId: this.api.id,
                integrationType: 'AWS_PROXY',
                integrationUri: args.lambdaArn,
                integrationMethod: 'POST',
                payloadFormatVersion: '2.0',
            },
            defaultOpts,
        );

        args.routes.forEach((route) => {
            const slug = route.routeKey.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();
            const authorized = route.authorized ?? true;
            new aws.apigatewayv2.Route(
                `${name}-route-${slug}`,
                {
                    apiId: this.api.id,
                    routeKey: route.routeKey,
                    target: pulumi.interpolate`integrations/${integration.id}`,
                    authorizationType: authorized ? 'JWT' : 'NONE',
                    authorizerId: authorized ? this.authorizer.id : undefined,
                },
                defaultOpts,
            );
        });

        this.stage = new aws.apigatewayv2.Stage(
            `${name}-stage`,
            {
                apiId: this.api.id,
                name: '$default',
                autoDeploy: true,
                defaultRouteSettings: args.throttle
                    ? {
                          throttlingRateLimit: args.throttle.rateLimit,
                          throttlingBurstLimit: args.throttle.burstLimit,
                          detailedMetricsEnabled: true,
                      }
                    : undefined,
                tags: mergedTags,
            },
            defaultOpts,
        );

        // Allow API Gateway to invoke the Lambda for any route on this API.
        new aws.lambda.Permission(
            `${name}-invoke`,
            {
                action: 'lambda:InvokeFunction',
                function: args.lambdaName,
                principal: 'apigateway.amazonaws.com',
                sourceArn: pulumi.interpolate`${this.api.executionArn}/*/*`,
            },
            defaultOpts,
        );

        this.endpoint = this.api.apiEndpoint;

        this.registerOutputs({
            api: this.api,
            authorizer: this.authorizer,
            stage: this.stage,
            endpoint: this.endpoint,
        });
    }
}

export default HttpApiComponent;
