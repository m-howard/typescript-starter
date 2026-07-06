/**
 * Chat / Retrieve API - The authorization enforcement point.
 *
 * Authentication (the JWT authorizer on the route) proves *who* the caller is. This handler adds
 * the missing half: it resolves the caller's IdP groups from the validated token and passes a
 * metadata ACL filter into every RetrieveAndGenerate call, so vector search only ever returns
 * chunks whose `visibility_groups` intersect the caller's groups. Restricted content never reaches
 * the model. The filter is built fail-closed — a caller with no groups can see only public docs.
 *
 * The canonical, unit-tested filter logic lives in `src/rag/acl-filter.ts`; the small builder
 * below mirrors it for the zero-dependency Lambda bundle.
 *
 * Env: KNOWLEDGE_BASE_ID, MODEL_ARN, GUARDRAIL_ID, GUARDRAIL_VERSION
 */
import {
    BedrockAgentRuntimeClient,
    RetrieveAndGenerateCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';

const client = new BedrockAgentRuntimeClient({});

const VISIBILITY_GROUPS_KEY = 'visibility_groups';
const PUBLIC_GROUP = 'public';

/** Mirror of src/rag/acl-filter.ts buildAclFilter (fail-closed, public sentinel folded in). */
function buildAclFilter(rawGroups) {
    const effective = new Set((rawGroups ?? []).map((g) => g.trim()).filter((g) => g.length > 0));
    effective.add(PUBLIC_GROUP);
    const clauses = [...effective].map((group) => ({
        listContains: { key: VISIBILITY_GROUPS_KEY, value: group },
    }));
    return clauses.length === 1 ? clauses[0] : { orAll: clauses };
}

/** IdP group claims may arrive as a JSON array, a comma/space-separated string, or be absent. */
function parseGroups(claims) {
    const raw = claims?.['custom:groups'] ?? claims?.groups ?? '';
    if (Array.isArray(raw)) return raw;
    const trimmed = String(raw).trim();
    if (trimmed.startsWith('[')) {
        try {
            return JSON.parse(trimmed);
        } catch {
            /* fall through to delimiter parsing */
        }
    }
    return trimmed.split(/[,\s]+/).filter(Boolean);
}

export const handler = async (event) => {
    const claims = event.requestContext?.authorizer?.jwt?.claims ?? {};
    const groups = parseGroups(claims);
    const filter = buildAclFilter(groups);

    let body;
    try {
        body = JSON.parse(event.body ?? '{}');
    } catch {
        return json(400, { error: 'Invalid JSON body.' });
    }
    const question = (body.question ?? '').trim();
    if (!question) {
        return json(400, { error: 'A "question" field is required.' });
    }

    const command = new RetrieveAndGenerateCommand({
        input: { text: question },
        retrieveAndGenerateConfiguration: {
            type: 'KNOWLEDGE_BASE',
            knowledgeBaseConfiguration: {
                knowledgeBaseId: process.env.KNOWLEDGE_BASE_ID,
                modelArn: process.env.MODEL_ARN,
                // The ACL filter: retrieval is constrained to the caller's authorized groups.
                retrievalConfiguration: {
                    vectorSearchConfiguration: { filter },
                },
                generationConfiguration: process.env.GUARDRAIL_ID
                    ? {
                          guardrailConfiguration: {
                              guardrailId: process.env.GUARDRAIL_ID,
                              guardrailVersion: process.env.GUARDRAIL_VERSION ?? 'DRAFT',
                          },
                      }
                    : undefined,
            },
        },
    });

    const result = await client.send(command);

    // Enforce citations: refuse rather than fabricate when retrieval returns nothing authorized.
    const citations = (result.citations ?? []).flatMap((c) =>
        (c.retrievedReferences ?? []).map((r) => r.location?.s3Location?.uri).filter(Boolean),
    );
    if (citations.length === 0) {
        return json(200, {
            answer: 'No answer is available from the documents you have access to.',
            citations: [],
        });
    }

    return json(200, { answer: result.output?.text ?? '', citations });
};

function json(statusCode, payload) {
    return {
        statusCode,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
    };
}
