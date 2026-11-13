export function onSignup(user: User) {
	queue.push(job);
	metrics.inc('jobs');
}
