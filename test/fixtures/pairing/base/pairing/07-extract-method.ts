export async function exportReport(rows: Row[], title: string, path: string) {
	const report = buildReport(rows);
	report.title = title;
	report.owner = team.lead;
	report.sortBy("date");
	const writer = new CsvWriter(settings.delimiter);
	writer.header(report.columns);
	for (const row of report.rows) writer.row(row);
	await writer.flush(path);
}
