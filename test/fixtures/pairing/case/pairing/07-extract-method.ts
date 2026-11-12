export async function exportReport(rows: Row[], title: string, path: string) {
	const report = new CsvReport(rows, settings.delimiter);
	report.title = title.trim();
	report.owner = team.lead.name;
	report.sortBy("date", "desc");
	return exportCsv(report, path);
}
