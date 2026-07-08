import React from 'react';

// Modal grid of screen/window thumbnails for choosing a screenshare source.
function ScreenSourcePicker({ sources = [], onSelect, onClose }) {
	return (
		<div
			className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 p-6"
			onClick={onClose}
		>
			<div
				className="bg-[#E9E9DF] border border-[#CBCDC2] rounded-2xl p-4 max-w-3xl w-full max-h-[80vh] overflow-y-auto shadow-xl"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="flex items-center justify-between mb-3">
					<h2 className="text-base font-semibold text-foreground">Share a screen or window</h2>
					<button
						onClick={onClose}
						className="text-muted-foreground hover:text-foreground transition-colors"
						aria-label="Close source picker"
					>
						✕
					</button>
				</div>
				<div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
					{sources.map((source) => (
						<button
							key={source.id}
							onClick={() => onSelect(source.id)}
							className="text-left rounded-xl border border-border/40 bg-white/40 hover:border-primary hover:shadow-md transition-all overflow-hidden"
							title={source.name}
						>
							<img
								src={source.thumbnail}
								alt={source.name}
								className="w-full h-28 object-contain bg-black/80"
							/>
							<p className="px-2 py-1.5 text-xs text-foreground truncate">{source.name}</p>
						</button>
					))}
					{sources.length === 0 && (
						<p className="text-sm text-muted-foreground col-span-3 p-4">No sources available.</p>
					)}
				</div>
			</div>
		</div>
	);
}

export default ScreenSourcePicker;
