import { type ZodType, z } from 'zod'
import type {
	AnyFnContext,
	FnDefinition,
	FnRouteOptions,
	GuardOptions,
	ProcedureKey,
	ProcedureOption
} from '../types.js'
import type {
	CreatePubSub,
	ObjectSchema,
	PubSub,
	PubSubOptions
} from './pub-sub.js'

/** Where a change bus partitions its channels, e.g. one per organization. */
export type ChangeBusScope<TContext, TEvent> = {
	/** The subscriber's scope key, from its context. Throw to refuse the subscription. */
	subscribe: (context: TContext) => string
	/** The event's scope key, carried in the event itself. */
	publish: (event: TEvent) => string
}

/** A bus's channel definition; pass it to `fnLive` to share the bus's events. */
export type ChangeBusChannel<TContext, TEvent> = {
	subscribe: (params: { context: TContext }) => string
	publish: (event: TEvent) => string
}

export type ScopedChangeBus<
	TDef extends FnDefinition,
	TInputSchema extends ObjectSchema,
	TEventSchema extends ZodType,
	TKey extends ProcedureKey<TDef>,
	TScopeEvent
> = PubSub<TDef, TInputSchema, TEventSchema, TKey> & {
	channel: ChangeBusChannel<AnyFnContext<TDef>, TScopeEvent>
	/**
	 * The full channel name for a scope, namespace included:
	 * `backlogKey(bus.channelFor({ organizationId }))` reads its backlog.
	 */
	channelFor: (scope: TScopeEvent) => string
}

const noInput = z.object({})

/**
 * Binds the app's `createPubSub` to one scope rule, for buses that tell every
 * subscriber in a scope "something changed". Each bus then names only its
 * channel prefix: events go to `${prefix}:${scope}`. Publishing is safe by
 * default (`safePublish: true`), because buses publish after committed writes.
 *
 * ```ts
 * const defineChangeBus = defineScopedChangeBus(createPubSub, {
 *   subscribe: (context) => activeOrganizationId(context),
 *   publish: (event: { organizationId: string }) => event.organizationId
 * })
 * export const dealChanges = defineChangeBus({
 *   name: 'deal.subscribe',
 *   prefix: 'deal:change',
 *   eventSchema: z.object({ organizationId: z.string(), dealId: z.string() })
 * })
 * // fnLive({ live: { channel: dealChanges.channel, ... } }) shares the channel.
 * ```
 */
export function defineScopedChangeBus<TDef extends FnDefinition, TScopeEvent>(
	createPubSub: CreatePubSub<TDef>,
	scope: ChangeBusScope<AnyFnContext<TDef>, TScopeEvent>
) {
	return <
		TEventSchema extends ZodType<TScopeEvent>,
		TInputSchema extends ObjectSchema = typeof noInput,
		TKey extends ProcedureKey<TDef> = TDef['default']
	>(
		options: Omit<
			PubSubOptions<TDef, TInputSchema, TEventSchema, NoInfer<TKey>>,
			'channel' | 'inputSchema'
		> &
			GuardOptions<TDef['guards']> &
			Pick<
				FnRouteOptions<TDef, TKey, z.output<TInputSchema>>,
				'meta' | 'guardResolvers'
			> &
			ProcedureOption<TDef, TKey> & {
				/** Channel prefix; the scope key is appended as `${prefix}:${scope}`. */
				prefix: string
				/** What the subscriber provides (default: no input). */
				inputSchema?: TInputSchema
			}
	): ScopedChangeBus<TDef, TInputSchema, TEventSchema, TKey, TScopeEvent> => {
		const { prefix, ...pubsubOptions } = options
		const channel: ChangeBusChannel<AnyFnContext<TDef>, TScopeEvent> = {
			subscribe: ({ context }) => `${prefix}:${scope.subscribe(context)}`,
			publish: (event) => `${prefix}:${scope.publish(event)}`
		}
		// The bus's context is one member of AnyFnContext, which the generic
		// signature of createPubSub cannot see.
		const bus = (createPubSub as (options: object) => object)({
			safePublish: true,
			...pubsubOptions,
			inputSchema: pubsubOptions.inputSchema ?? noInput,
			channel
		}) as PubSub<TDef, TInputSchema, TEventSchema, TKey>
		// The scope reads only its own fields, so a scope stands in for an event.
		const channelFor = bus.getPublishChannelName as (
			scope: TScopeEvent
		) => string
		return { ...bus, channel, channelFor }
	}
}
