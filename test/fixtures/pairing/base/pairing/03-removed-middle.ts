export async function load() {
	const user = await retry(getUser, 3);
	log("fetching orders");
	const orders = await retry(getOrders, 3);
	return { user, orders };
}
