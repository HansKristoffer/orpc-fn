import { describe, expect, test } from 'bun:test'
import { CliError, defineCli } from 'hanzio/cli'
import { z } from 'zod'
import { createRouter, fn, type PublicContext, user } from '../tests/fixture.js'
import { procedureCommands } from './procedure-cli.js'

const router = createRouter({
	dealRoom: {
		openDeals: fn({
			name: 'dealRoom.openDeals',
			summary: 'List open deals',
			meta: { cli: true },
			input: z.object({
				stage: z.string().meta({ positional: true }),
				limit: z.number().default(10)
			}),
			permission: { deal: ['read'] },
			handler: ({ input, context }) => ({
				userId: context.user.id,
				stage: input.stage,
				limit: input.limit
			})
		}),
		notOnCli: fn({
			name: 'dealRoom.notOnCli',
			handler: () => 'hidden'
		})
	},
	internal: {
		onlyHttp: fn({ name: 'internal.onlyHttp', handler: () => 'hidden' })
	}
})

function createCli(context: PublicContext) {
	return defineCli({
		name: 'app',
		context: () => context,
		commands: procedureCommands<PublicContext>(router)
	})
}

async function run(context: PublicContext, argv: string[]) {
	let stdout = ''
	let stderr = ''
	const code = await createCli(context).run(argv, {
		stdout: { write: (text: string) => (stdout += text) },
		stderr: { write: (text: string) => (stderr += text) },
		env: {}
	})
	return { code, stdout, stderr }
}

describe('procedureCommands', () => {
	test('keeps only opted-in procedures, kebab-cased like the router', () => {
		const commands = procedureCommands(router)

		expect(Object.keys(commands)).toEqual(['deal-room'])
		expect(Object.keys(commands['deal-room'] ?? {})).toEqual(['open-deals'])
	})

	test('runs the procedure with the CLI context and prints its result', async () => {
		const result = await run({ user: user({ id: 'user-7' }) }, [
			'deal-room',
			'open-deals',
			'won',
			'--limit',
			'3'
		])

		expect(result.code).toBe(0)
		expect(JSON.parse(result.stdout)).toEqual({
			userId: 'user-7',
			stage: 'won',
			limit: 3
		})
	})

	test('help comes from the summary and the input schema', async () => {
		const result = await run({}, ['deal-room', 'open-deals', '--help'])

		expect(result.stdout).toContain('List open deals')
		expect(result.stdout).toContain('<stage>')
		expect(result.stdout).toContain('--limit <number>')
	})

	test('middleware and guards refuse as over HTTP, as a message', async () => {
		const anonymous = await run({}, ['deal-room', 'open-deals', 'won'])
		expect(anonymous.code).toBe(1)
		expect(anonymous.stderr).toBe('UNAUTHORIZED: Unauthorized\n')

		const denied = await run(
			{
				user: user({
					canPermission: () => {
						throw new Error('no deal access')
					}
				})
			},
			['deal-room', 'open-deals', 'won']
		)
		expect(denied.code).toBe(1)
		expect(denied.stderr).toContain('no deal access')
	})

	test('the context option maps the CLI context and can refuse early', async () => {
		const cli = defineCli({
			name: 'app',
			context: (): { actor?: string } => ({}),
			commands: procedureCommands<{ actor?: string }>(router, {
				context: (cliContext, meta) => {
					if (meta.procedure === 'protected' && !cliContext.actor) {
						throw new CliError(`${meta.name} needs --as`, { exitCode: 2 })
					}
					return { user: user() }
				}
			})
		})
		let stderr = ''

		const code = await cli.run(['deal-room', 'open-deals', 'won'], {
			stderr: { write: (text: string) => (stderr += text) },
			env: {}
		})

		expect(code).toBe(2)
		expect(stderr).toBe('dealRoom.openDeals needs --as\n')
	})

	test('a streaming procedure cannot be a command', () => {
		const streams = createRouter({
			watch: fn({
				name: 'watch',
				meta: { cli: true },
				stream: true,
				handler: async function* () {
					yield 1
				}
			})
		})

		expect(() => procedureCommands(streams)).toThrow('streams')
	})
})
