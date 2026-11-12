export async function load() {
	const user = await retry(getUser, 5);
	const orders = await retry(getOrders, 5);
	return { user, orders };
}
