import { spawn } from 'child_process'

export const exec = async ({
	cmdWithArgs,
	log,
	error,
}: {
	cmdWithArgs: string[]
	log?: (...args: string[]) => void
	error?: (...args: string[]) => void
}): Promise<void> =>
	new Promise((resolve, reject) => {
		const [cmd, ...args] = cmdWithArgs
		const p = spawn(cmd, args)
		p.stdout.on('data', (data) => {
			data
				.toString()
				.trim()
				.split('\n')
				.filter((s: string) => s.length)
				.map((s: string) => {
					log?.(s)
				})
		})

		p.stderr.on('data', (data) => {
			data
				.toString()
				.trim()
				.split('\n')
				.filter((s: string) => s.length)
				.map((s: string) => {
					error?.(s)
				})
		})

		p.on('exit', (code) => {
			if (code === 0) return resolve()
			return reject(code)
		})
	})
