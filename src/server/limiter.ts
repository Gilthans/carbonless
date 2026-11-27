/** Runs the tasks given to it at most `max` at a time, in the order given. */
export function limiter(max: number) {
	let running = 0;
	const queue: (() => void)[] = [];
	const next = () => {
		if (running >= max) return;
		const start = queue.shift();
		if (start) start();
	};
	return <T>(task: () => Promise<T>): Promise<T> =>
		new Promise<T>((resolve, reject) => {
			queue.push(() => {
				running++;
				task()
					.then(resolve, reject)
					.finally(() => {
						running--;
						next();
					});
			});
			next();
		});
}
