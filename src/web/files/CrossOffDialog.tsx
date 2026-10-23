import { useForm } from "@tanstack/react-form";

const QUICK_PICKS = ["generated", "rename only"];

const requireReason = ({ value }: { value: string }) =>
	value.trim() ? undefined : "A reason is required";

/** Asks why a file is crossed off; `onConfirm` gets the trimmed reason. */
export function CrossOffDialog(props: {
	path: string;
	disabled: boolean;
	onConfirm: (reason: string) => Promise<void>;
	onCancel: () => void;
}) {
	const form = useForm({
		defaultValues: { reason: "" },
		onSubmit: ({ value }) => props.onConfirm(value.reason.trim()),
	});
	const inputId = `cross-off-${props.path}`;
	return (
		<div
			role="dialog"
			aria-label="Cross off file"
			className="border-b border-purple-200 bg-purple-50 px-3 py-3"
			onKeyDown={(event) => {
				if (event.key === "Escape") props.onCancel();
			}}
		>
			<form
				className="flex flex-wrap items-start gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					event.stopPropagation();
					void form.handleSubmit();
				}}
			>
				<form.Field
					name="reason"
					validators={{ onChange: requireReason, onSubmit: requireReason }}
				>
					{(field) => (
						<div className="flex min-w-0 flex-1 flex-col gap-1">
							<div className="flex flex-wrap items-center gap-2">
								<label htmlFor={inputId} className="text-sm font-medium">
									Reason
								</label>
								<input
									id={inputId}
									// The dialog opens on request; typing the reason is the next step.
									// biome-ignore lint/a11y/noAutofocus: see above.
									autoFocus
									value={field.state.value}
									onChange={(event) => field.handleChange(event.target.value)}
									onBlur={field.handleBlur}
									maxLength={500}
									className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-blue-600"
								/>
								{QUICK_PICKS.map((pick) => (
									<button
										key={pick}
										type="button"
										onClick={() => field.handleChange(pick)}
										className="rounded-full border border-purple-300 bg-white px-2 py-0.5 text-xs text-purple-800 hover:bg-purple-100 focus-visible:outline-2 focus-visible:outline-blue-600"
									>
										{pick}
									</button>
								))}
							</div>
							{field.state.meta.errors.length > 0 && (
								<p className="text-sm text-red-700">
									{field.state.meta.errors.join(", ")}
								</p>
							)}
						</div>
					)}
				</form.Field>
				<form.Subscribe selector={(state) => state.isSubmitting}>
					{(submitting) => (
						<div className="flex gap-2">
							<button
								type="submit"
								disabled={submitting || props.disabled}
								className="rounded-md bg-purple-700 px-3 py-1 text-sm font-medium text-white hover:bg-purple-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-60"
							>
								Cross off
							</button>
							<button
								type="button"
								onClick={props.onCancel}
								className="rounded-md border border-slate-300 bg-white px-3 py-1 text-sm hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-blue-600"
							>
								Cancel
							</button>
						</div>
					)}
				</form.Subscribe>
			</form>
		</div>
	);
}
