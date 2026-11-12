/** A Standard Schema issue, as oRPC puts them on `error.data.issues`. */
export type SchemaIssue = {
	message: string
	path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> | undefined
}

/** `items.0.name: Required`, or the bare message for a root issue. */
export function formatIssue(issue: SchemaIssue): string {
	const path = (issue.path ?? [])
		.map((segment) =>
			String(typeof segment === 'object' ? segment.key : segment)
		)
		.join('.')
	return path ? `${path}: ${issue.message}` : issue.message
}

/** The validation issues oRPC attaches to a BAD_REQUEST (`data.issues`). */
export function issuesOf(error: unknown): SchemaIssue[] {
	const data =
		typeof error === 'object' && error !== null
			? (error as { data?: unknown }).data
			: undefined
	const issues =
		typeof data === 'object' && data !== null
			? (data as { issues?: unknown }).issues
			: undefined
	return Array.isArray(issues)
		? issues.filter(
				(issue): issue is SchemaIssue =>
					typeof issue === 'object' &&
					issue !== null &&
					typeof (issue as { message?: unknown }).message === 'string'
			)
		: []
}
