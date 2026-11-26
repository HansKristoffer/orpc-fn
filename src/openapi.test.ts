import { describe, expect, test } from 'bun:test'
import { ORPCError } from '@orpc/server'
import { Hono } from 'hono'
import { z } from 'zod'
import { createRouter, fn } from '../tests/fixture.js'
import { mountOrpc } from './hono.js'
import { listTools } from './mcp.js'
import { generateOpenApiDocument, hasTag } from './openapi.js'

const Attachment = z.object({ name: z.string(), url: z.string() })
const Feedback = z
	.object({ id: z.string(), attachments: z.array(Attachment) })
	.meta({ description: 'One feedback item' })
const Reporter = z.object({ email: z.email() })
// Sent by webhook, so no route refers to it.
const FeedbackEvent = z.object({
	type: z.literal('feedback.created'),
	at: z.date(),
	feedback: Feedback
})
const ErrorBody = z.object({
	code: z.string(),
	status: z.number(),
	message: z.string()
})

const getFeedback = fn({
	name: 'feedback.get',
	procedure: 'public',
	method: 'GET',
	path: '/feedback/{id}',
	tags: ['external'],
	input: z.object({ id: z.string() }),
	output: Feedback,
	handler: ({ input }) => ({ id: input.id, attachments: [] })
})
const fileFeedback = fn({
	name: 'feedback.file',
	procedure: 'public',
	method: 'POST',
	path: '/feedback',
	tags: ['external'],
	input: z.object({ reporter: Reporter, text: z.string() }),
	output: Feedback,
	handler: () => {
		throw new ORPCError('NOT_FOUND')
	}
})
const secret = fn({
	name: 'secret',
	procedure: 'public',
	method: 'GET',
	path: '/secret',
	handler: () => ({ ok: true })
})
const router = createRouter({ getFeedback, fileFeedback, secret })

const components = {
	Error: ErrorBody,
	Feedback,
	Attachment,
	Reporter: { schema: Reporter, only: 'input' as const },
	FeedbackEvent: { schema: FeedbackEvent, only: 'output' as const }
}

type Document = {
	openapi: string
	paths: Record<string, Record<string, unknown>>
	components?: { schemas?: Record<string, Record<string, unknown>> }
}
/** The document as a client reads it, from JSON. */
const asDocument = (value: unknown) =>
	JSON.parse(JSON.stringify(value)) as Document

describe('generateOpenApiDocument', () => {
	test('names components where routes use them, and lists the ones no route uses', async () => {
		const document = asDocument(
			await generateOpenApiDocument(router, {
				filter: hasTag('external'),
				version: '3.1.1',
				base: { info: { title: 'Feedback API', version: '1.0.0' } },
				components
			})
		)
		expect(document.openapi).toBe('3.1.1')
		expect(Object.keys(document.paths)).toEqual(['/feedback/{id}', '/feedback'])
		const schemas = document.components?.schemas ?? {}
		expect(Object.keys(schemas).sort()).toEqual([
			'Attachment',
			'Error',
			'Feedback',
			'FeedbackEvent',
			'Reporter'
		])
		// A route's output refers to the component, which keeps its global metadata.
		expect(JSON.stringify(document.paths['/feedback/{id}'])).toContain(
			'"$ref":"#/components/schemas/Feedback"'
		)
		expect(schemas.Feedback?.description).toBe('One feedback item')
		expect(JSON.stringify(schemas.Feedback)).toContain(
			'#/components/schemas/Attachment'
		)
		// The unreferenced webhook payload refers to components and dates read as strings.
		expect(schemas.FeedbackEvent).toMatchObject({
			properties: {
				at: { type: 'string', format: 'date-time' },
				feedback: { $ref: '#/components/schemas/Feedback' }
			}
		})
		expect(schemas.FeedbackEvent?.$schema).toBeUndefined()
	})

	test('a component limited to one direction is not named in the other', async () => {
		const document = asDocument(
			await generateOpenApiDocument(router, {
				filter: hasTag('external'),
				components: { Feedback: { schema: Feedback, only: 'input' } }
			})
		)
		expect(JSON.stringify(document.paths)).not.toContain(
			'#/components/schemas/Feedback'
		)
	})

	test('names stay out of the global registry, so tool schemas do not change', async () => {
		await generateOpenApiDocument(router, { filter: () => true, components })
		expect(z.globalRegistry.get(Feedback)?.id).toBeUndefined()
		const [tool] = listTools(createRouter({ fileFeedback }))
		const json = tool?.config.inputSchema?.['~standard'].jsonSchema.input()
		expect(JSON.stringify(json)).not.toContain('$ref')
	})

	test('without components it is oRPC generator output, and options are checked', async () => {
		const document = asDocument(
			await generateOpenApiDocument(router, {
				filter: () => true
			})
		)
		expect(Object.keys(document.paths)).toContain('/secret')
		await expect(
			// @ts-expect-error what to document is an explicit choice
			generateOpenApiDocument(router, {})
		).rejects.toThrow('needs a filter')
		await expect(
			generateOpenApiDocument(router, {
				filter: () => true,
				components: { Twice: Feedback, Again: Feedback }
			})
		).rejects.toThrow('Twice and Again name the same schema')
		await expect(
			generateOpenApiDocument(router, {
				filter: () => true,
				// @ts-expect-error only: 'input' or 'output'
				components: { Bad: { schema: Feedback, only: 'both' } }
			})
		).rejects.toThrow("only: 'both'")
	})
})

describe('mountOrpc openapi docs', () => {
	test('the spec names components, and an app can serve its own document', async () => {
		const app = new Hono()
		mountOrpc(app, {
			router,
			openapi: [
				{ prefix: '/api', filter: hasTag('external'), components },
				{
					prefix: '/own',
					filter: hasTag('external'),
					document: async () => ({
						...(await generateOpenApiDocument(router, {
							filter: hasTag('external'),
							components
						})),
						'x-finished-by': 'app'
					})
				}
			]
		})
		const spec = (await (
			await app.request('/api/spec.json')
		).json()) as Document
		expect(Object.keys(spec.components?.schemas ?? {})).toContain(
			'FeedbackEvent'
		)
		const own = (await (await app.request('/own/spec.json')).json()) as Record<
			string,
			unknown
		>
		expect(own['x-finished-by']).toBe('app')
	})

	test('a failed document is asked for again on the next request', async () => {
		let calls = 0
		const app = new Hono()
		// Hono answers the failure with a 500; its default handler would print it.
		app.onError((_error, c) => c.text('Internal Server Error', 500))
		mountOrpc(app, {
			router,
			openapi: {
				prefix: '/api',
				filter: () => true,
				document: async () => {
					calls++
					if (calls === 1) throw new Error('not ready')
					return { openapi: '3.1.1', info: { title: 'Own', version: '1' } }
				}
			}
		})
		expect((await app.request('/api/spec.json')).status).toBe(500)
		expect(await (await app.request('/api/spec.json')).json()).toEqual({
			openapi: '3.1.1',
			info: { title: 'Own', version: '1' }
		})
		expect(calls).toBe(2)
	})

	test('docs pages and surfaces may not share a path or a prefix', () => {
		expect(() =>
			mountOrpc(new Hono(), {
				router,
				openapi: {
					prefix: '/api',
					filter: () => true,
					docs: [{ path: '/customer' }, {}]
				}
			})
		).toThrow('two openapi docs pages under /api use /spec.json')
		expect(() =>
			mountOrpc(new Hono(), {
				router,
				openapi: [
					{ prefix: '/api', filter: () => true },
					{ prefix: '/api/', filter: () => true }
				]
			})
		).toThrow('two openapi surfaces share the prefix /api/')
	})
})
