// Shared test setup: an app-shaped createFn with public/protected/support
// procedures, a dummy guard pair, extras and typed meta.
import { ORPCError, os } from '@orpc/server'
import { createFn, type FnLogger } from '../src/index.js'
import { memoryTransport } from '../src/live/memory.js'

export type User = {
	id: string
	email: string
	locale: 'en' | 'da'
	featureFlags: string[]
	canPermission: (requirement: Permission) => void
}
export type Permission = Record<string, string[]>
export type Timing = {
	queue_ms?: number
	auth_ms?: number
	handler_ms?: number
}
export type PublicContext = {
	headers?: Headers
	user?: User
	support?: { sessionId: string; organizationId: string }
	timing?: Timing
}
export type ProtectedContext = PublicContext & { user: User }
export type SupportContext = PublicContext & {
	support: NonNullable<PublicContext['support']>
}

const base = os.$context<PublicContext>()
export const protectedProcedure = base.use(({ context, next }) => {
	if (!context.user) throw new ORPCError('UNAUTHORIZED')
	return next({ context: { user: context.user } })
})
export const supportProcedure = base.use(({ context, next }) => {
	if (!context.support) throw new ORPCError('FORBIDDEN')
	return next({ context: { support: context.support } })
})

export function user(overrides: Partial<User> = {}): User {
	return {
		id: 'user-1',
		email: 'user@example.com',
		locale: 'en',
		featureFlags: [],
		canPermission: () => {},
		...overrides
	}
}

export const transport = memoryTransport()
export const completed: Array<Record<string, unknown>> = []

export const {
	fn,
	fnLive,
	createPubSub,
	createPublisher,
	createRouter,
	readMeta,
	drainPubSubSubscribers,
	activePubSubSubscriberCount
} = createFn({
	procedures: {
		public: base,
		protected: protectedProcedure,
		support: supportProcedure
	},
	default: 'protected',
	tags: ['internal', 'external', 'mcp-support', 'mcp-readonly'],
	meta: {} as { readOnly?: boolean; automationSafe?: boolean },
	extras: ({ context }) => ({
		db: { query: (sql: string) => sql },
		t: context.user
			? (key: string) => `${context.user?.locale}:${key}`
			: undefined
	}),
	guards: {
		neededFeatureFlags: (flags: string[], { context }) => {
			for (const flag of flags) {
				if (!context.user?.featureFlags.includes(flag)) {
					throw new ORPCError('FORBIDDEN', {
						message: `Feature flag '${flag}' is not available`
					})
				}
			}
		},
		permission: (requirement: Permission, { context }) => {
			if (!context.user) throw new ORPCError('UNAUTHORIZED')
			context.user.canPermission(requirement)
		}
	},
	onCompleted: (event) => {
		completed.push({ name: event.name, success: event.success })
		return { organization_id: event.context.support?.organizationId }
	},
	logger: (): FnLogger => ({ debug() {}, info() {}, warn() {}, error() {} }),
	pubsub: { transport }
})
