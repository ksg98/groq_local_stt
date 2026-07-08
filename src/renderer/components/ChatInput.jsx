import { ArrowUp, Loader2, ImagePlus, Hammer, Upload, Zap, ZapOff, Square, Mic, MicOff, X, AudioLines, Monitor, Camera, Volume2, VolumeX } from "lucide-react";
import React, { useContext, useEffect, useRef, useState, useMemo, useCallback } from "react";
import TextAreaAutosize from "react-textarea-autosize";
import { SearchableSelect } from "./ui/SearchableSelect";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import { ChatContext } from "../context/ChatContext";
import { useSpeechToText } from "../hooks/useSpeechToText";

function ChatInput({
	onSendMessage,
	onStopGeneration,
	loading = false,
	visionSupported = false,
	models = [],
	selectedModel = "",
	onModelChange,
	onOpenMcpTools,
	modelConfigs = {},
	reasoningEffort = "medium",
	onReasoningEffortChange,
	voiceAgent = null,
	capture = null,
}) {
	const [message, setMessage] = useState("");
	const [suggestion, setSuggestion] = useState("");
	const [autocompleteEnabled, setAutocompleteEnabled] = useState(true);
	const suggestionTimeout = useRef(null);
	const { messages, activeContext } = useContext(ChatContext);

	const [files, setFiles] = useState([]); // Changed from images to files to handle all file types
	const [textareaHeight, setTextareaHeight] = useState(null);
	const [rowHeight, setRowHeight] = useState(null);

	// Helper function to get display name for a model
	const getModelDisplayName = (modelId) => {
		const modelInfo = modelConfigs[modelId];
		if (modelInfo && modelInfo.displayName) {
			return modelInfo.displayName;
		}
		
		// If no explicit displayName is configured, return the raw modelId without auto-capitalization
		return modelId;
	};

	// Sort models alphabetically by display name
	const sortedModels = useMemo(() => {
		return [...models].sort((a, b) => {
			const nameA = getModelDisplayName(a).toLowerCase();
			const nameB = getModelDisplayName(b).toLowerCase();
			return nameA.localeCompare(nameB);
		});
	}, [models, modelConfigs]);

	// Reasoning effort levels supported by the selected model (from the
	// dynamically-fetched model configs); empty = no effort selector shown
	const effortOptions = useMemo(() => {
		const info = modelConfigs[selectedModel];
		return info?.reasoning?.efforts || [];
	}, [selectedModel, modelConfigs]);

	const getEffortLabel = (level) =>
		level ? level.charAt(0).toUpperCase() + level.slice(1) : level;
	const [isDragOver, setIsDragOver] = useState(false);
	const [fullScreenImage, setFullScreenImage] = useState(null);
	const textareaRef = useRef(null);
	const fileInputRef = useRef(null); // Ref for file input
	const prevLoadingRef = useRef(loading);
	const spaceHoldStartRef = useRef(null);
	const isSpaceHoldingRef = useRef(false);

	// Speech-to-text hook
	const handleTranscription = useCallback((text) => {
		// Append transcribed text to the message
		setMessage((prev) => {
			const separator = prev.trim() ? ' ' : '';
			return prev + separator + text;
		});
		// Focus the textarea after transcription
		if (textareaRef.current) {
			textareaRef.current.focus();
		}
	}, []);

	const handleSpeechError = useCallback((error) => {
		console.error('[ChatInput] Speech-to-text error:', error);
		// Could show a toast notification here
	}, []);

	const {
		isRecording,
		isTranscribing,
		recordingDuration,
		formattedDuration,
		error: speechError,
		startRecording,
		stopRecording,
		cancelRecording,
		toggleRecording,
	} = useSpeechToText({
		onTranscription: handleTranscription,
		onError: handleSpeechError,
	});
	

	// Live preview of the active screenshare/camera stream
	const capturePreviewRef = useRef(null);
	useEffect(() => {
		const video = capturePreviewRef.current;
		if (video && capture?.mode) {
			video.srcObject = capture.getPreviewStream?.() || null;
			video.play?.().catch(() => {});
		}
	}, [capture?.mode]);

	// Voice agent status pill styling per state
	const AGENT_STATE_STYLES = {
		starting: { label: 'Starting voice…', cls: 'bg-muted/40 border-border/50 text-muted-foreground', dot: 'bg-muted-foreground' },
		listening: { label: 'Listening', cls: 'bg-green-500/10 border-green-500/30 text-green-700', dot: 'bg-green-500 animate-pulse' },
		transcribing: { label: 'Transcribing…', cls: 'bg-amber-500/10 border-amber-500/30 text-amber-700', dot: 'bg-amber-500 animate-pulse' },
		thinking: { label: 'Thinking…', cls: 'bg-amber-500/10 border-amber-500/30 text-amber-700', dot: 'bg-amber-500 animate-pulse' },
		speaking: { label: 'Speaking', cls: 'bg-blue-500/10 border-blue-500/30 text-blue-700', dot: 'bg-blue-500 animate-pulse' },
		error: { label: 'Voice error', cls: 'bg-red-500/10 border-red-500/30 text-red-600', dot: 'bg-red-500' },
	};
	const agentStateInfo = (() => {
		if (!voiceAgent?.active) return null;
		const state = voiceAgent.agentState;
		const base = AGENT_STATE_STYLES[state] || AGENT_STATE_STYLES.starting;
		if (state === 'starting' && voiceAgent.ttsStatus?.state === 'loading') {
			return { ...base, label: 'Loading voice model…' };
		}
		return base;
	})();

	// Function to handle file selection (images and other files)
	const handleFileChange = (e) => {
		const selectedFiles = Array.from(e.target.files);
		const remainingSlots = 5 - files.length;

		// Check if any images are being uploaded with a non-vision model
		const hasImages = selectedFiles.some(file => file.type.startsWith("image/"));
		if (hasImages && !visionSupported) {
			alert("The selected model does not support image inputs. Please select a vision-capable model or upload text files only.");
			if (fileInputRef.current) fileInputRef.current.value = "";
			return;
		}

		if (selectedFiles.length > remainingSlots) {
			alert(
				`You can only add ${remainingSlots > 0 ? remainingSlots : "no more"} files (max 5).`,
			);
		}

		const filePromises = selectedFiles.slice(0, remainingSlots).map((file) => {
			return new Promise((resolve, reject) => {
				// Handle different file types
				if (file.type.startsWith("image/")) {
					// For images, create base64 preview
					const reader = new FileReader();
					reader.onloadend = () => {
						resolve({
							base64: reader.result,
							name: file.name,
							type: file.type,
							size: file.size,
							fileType: 'image',
						});
					};
					reader.onerror = reject;
					reader.readAsDataURL(file);
				} else {
					// For other files, just store file info without base64
					resolve({
						name: file.name,
						type: file.type,
						size: file.size,
						fileType: 'document',
						file: file, // Store the actual file for later processing
					});
				}
			});
		});

		Promise.all(filePromises)
			.then((newFiles) => {
				const validFiles = newFiles.filter((file) => file !== null);
				setFiles((prev) => [...prev, ...validFiles]);
				// Reset file input value to allow selecting the same file again
				if (fileInputRef.current) fileInputRef.current.value = "";
			})
			.catch((error) => {
				console.error("Error reading files:", error);
				alert("Error processing files.");
				if (fileInputRef.current) fileInputRef.current.value = "";
			});
	};

	// Function to remove a file
	const removeFile = (index) => {
		setFiles((prev) => prev.filter((_, i) => i !== index));
	};

	// Function to format file size
	const formatFileSize = (bytes) => {
		if (bytes === 0) return '0 Bytes';
		const k = 1024;
		const sizes = ['Bytes', 'KB', 'MB', 'GB'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
	};

	// Drag and drop handlers
	const handleDragOver = (e) => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragOver(true);
	};

	const handleDragLeave = (e) => {
		e.preventDefault();
		e.stopPropagation();
		// Only set dragOver to false if we're leaving the entire input area
		if (!e.currentTarget.contains(e.relatedTarget)) {
			setIsDragOver(false);
		}
	};

	const handleDrop = (e) => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragOver(false);
		
		const droppedFiles = Array.from(e.dataTransfer.files);
		if (droppedFiles.length > 0) {
			// Use the existing handleFileChange logic by creating a fake event
			const fakeEvent = {
				target: {
					files: droppedFiles
				}
			};
			handleFileChange(fakeEvent);
		}
	};



	// Focus the textarea after component mounts
	useEffect(() => {
		if (textareaRef.current) {
			textareaRef.current.focus();
		}
	}, []);

	// Focus the textarea when loading changes from true to false (completion finished)
	useEffect(() => {
		// Check if loading just changed from true to false
		if (prevLoadingRef.current && !loading) {
			if (textareaRef.current) {
				textareaRef.current.focus();
			}
		}
		// Update the ref with current loading state
		prevLoadingRef.current = loading;
	}, [loading]);

	// Handle Escape key for closing fullscreen image
	useEffect(() => {
		const handleKeyDown = (event) => {
			if (event.key === 'Escape' && fullScreenImage) {
				setFullScreenImage(null);
			}
		};

		if (fullScreenImage) {
			document.addEventListener('keydown', handleKeyDown);
		}

		return () => {
			document.removeEventListener('keydown', handleKeyDown);
		};
	}, [fullScreenImage]);

	// Push-to-talk with space bar (hold space for 500ms+ to activate)
	useEffect(() => {
		const HOLD_THRESHOLD = 500; // ms to hold before activating

		const handleGlobalKeyDown = (event) => {
			// Only handle space key
			if (event.code !== 'Space') return;

			// Don't trigger if already holding or recording, or while the voice
			// agent owns the microphone
			if (isSpaceHoldingRef.current || isRecording || isTranscribing || loading || voiceAgent?.active) return;

			// Check if we're focused on the textarea
			const isTextareaFocused = document.activeElement === textareaRef.current;

			// Only activate push-to-talk if:
			// 1. We're in the textarea AND holding for threshold
			// 2. OR we're not in any input
			const isInInput = document.activeElement && (
				document.activeElement.tagName === 'INPUT' ||
				document.activeElement.tagName === 'TEXTAREA' ||
				document.activeElement.isContentEditable
			);

			if (!isInInput || isTextareaFocused) {
				spaceHoldStartRef.current = Date.now();
				isSpaceHoldingRef.current = true;

				// Start checking for hold threshold
				const checkThreshold = () => {
					if (isSpaceHoldingRef.current && spaceHoldStartRef.current) {
						const holdDuration = Date.now() - spaceHoldStartRef.current;
						if (holdDuration >= HOLD_THRESHOLD && !isRecording) {
							// Long hold detected - start recording
							event.preventDefault();
							startRecording(true);
						}
					}
				};

				// Check after threshold
				setTimeout(checkThreshold, HOLD_THRESHOLD);
			}
		};

		const handleGlobalKeyUp = (event) => {
			if (event.code !== 'Space') return;

			if (isSpaceHoldingRef.current) {
				const holdDuration = spaceHoldStartRef.current ? Date.now() - spaceHoldStartRef.current : 0;

				// If we're recording (long hold was detected), stop recording
				if (isRecording) {
					event.preventDefault();
					if (holdDuration >= HOLD_THRESHOLD) {
						stopRecording();
					} else {
						cancelRecording();
					}
				}

				isSpaceHoldingRef.current = false;
				spaceHoldStartRef.current = null;
			}
		};

		window.addEventListener('keydown', handleGlobalKeyDown);
		window.addEventListener('keyup', handleGlobalKeyUp);

		return () => {
			window.removeEventListener('keydown', handleGlobalKeyDown);
			window.removeEventListener('keyup', handleGlobalKeyUp);
		};
	}, [isRecording, isTranscribing, loading, startRecording, stopRecording, cancelRecording, voiceAgent?.active]);

	const handleSubmit = (e) => {
		e.preventDefault();
		const textContent = message.trim();
		const hasText = textContent.length > 0;
		const hasFiles = files.length > 0;

		if ((hasText || hasFiles) && !loading) {
			let contentToSend;
			if (hasFiles) {
				// Format content as array with text and file parts
				const contentParts = [];
				
				// Add text part only if there is text
				if (hasText) {
					contentParts.push({ type: "text", text: textContent });
				}
				
				// Add file parts
				files.forEach((file) => {
					if (file.fileType === 'image' && file.base64) {
						// For images, send as image_url
						contentParts.push({
							type: "image_url",
							image_url: { url: file.base64 },
						});
					} else {
						// For other files, send as text description (since most models can't process files directly)
						contentParts.push({
							type: "text",
							text: `[File: ${file.name} (${file.type}, ${formatFileSize(file.size)})]`,
						});
					}
				});
				
				contentToSend = contentParts;
			} else {
				// If no files, send only the text string
				contentToSend = [{ type: "text", text: textContent }];
			}

			onSendMessage(contentToSend);
			setMessage("");
			setFiles([]); // Clear files after sending
			setSuggestion(""); // Clear suggestion on send
		}
	};

	const handleKeyDown = (e) => {
		// Accept suggestion on Tab (only if autocomplete is enabled)
		if (e.key === "Tab" && autocompleteEnabled && suggestion) {
			e.preventDefault();
			setMessage(message + suggestion);
			setSuggestion("");
			return; // Prevent other key handlers from firing
		}

		// Clear suggestion on escape
		if (e.key === "Escape" && suggestion) {
			e.preventDefault();
			setSuggestion("");
			return;
		}

		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			// Prevent submission during loading
			if (!loading) {
				handleSubmit(e);
			}
		}
	};

	// Handle paste events to ensure textarea resizes properly
	const handlePaste = (e) => {
		// Don't prevent default - let the paste happen naturally
		// Just ensure the textarea resizes properly after paste
		setTimeout(() => {
			// Force a resize check after paste completes
			if (textareaRef.current && textareaRef.current._resizeComponent) {
				textareaRef.current._resizeComponent();
			}
		}, 0);
	};

	// Handle height changes to track when resizing occurs
	const handleHeightChange = (height, info) => {
		// Track the current height and row height
		setTextareaHeight(height);
		if (info && info.rowHeight) {
			setRowHeight(info.rowHeight);
		}
	};

	// Calculate if we're at max height (10 rows + padding)
	// Account for padding (py-3 = 0.75rem * 2 = 1.5rem = 24px at default font size)
	const maxHeightThreshold = rowHeight ? (rowHeight * 10) + 24 : null;
	const isAtMaxHeight = textareaHeight && maxHeightThreshold && textareaHeight >= maxHeightThreshold;

	return (
    <div 
			className={cn(
				"flex flex-col gap-4 border border-[#CBCDC2] rounded-2xl w-full p-3 bg-[#E9E9DF] backdrop-blur-sm",
				isDragOver 
					? "border-primary border-2 bg-primary/5 transition-all duration-200" 
					: ""
			)}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
		<form onSubmit={handleSubmit} className="flex flex-col gap-4">
			{/* File Previews Area */}
			{files.length > 0 && (
				<div className="flex flex-col gap-3">
					<p className="text-sm font-medium text-muted-foreground">
						Attached Files ({files.length}):
					</p>
					<div className="flex flex-wrap gap-3 p-3 border border-border/30 rounded-xl bg-muted/20">
						{files.map((file, index) => (
							<div key={index} className="relative group">
								{file.fileType === 'image' ? (
									// Image preview
									<div className="w-20 h-20">
										<img
											src={file.base64}
											alt={`Preview ${index + 1}`}
											className="w-full h-full object-cover rounded-lg cursor-pointer shadow-sm hover:opacity-80 transition-opacity"
											onClick={() => setFullScreenImage(file.base64)}
										/>
										<button
											type="button"
											onClick={() => removeFile(index)}
											className="absolute -top-2 -right-2 bg-destructive text-destructive-foreground rounded-full w-6 h-6 flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-all duration-200 shadow-md hover:scale-110"
											aria-label={`Remove file ${index + 1}`}
										>
											✕
										</button>
									</div>
								) : (
									// Document preview
									<div className="flex items-center gap-2 bg-background/80 rounded-lg p-3 border border-border/50 min-w-[200px]">
										<div className="w-8 h-8 bg-primary/10 rounded flex items-center justify-center">
											<Upload className="w-4 h-4 text-primary" />
										</div>
										<div className="flex-1 min-w-0">
											<p className="text-sm font-medium text-foreground truncate">{file.name}</p>
											<p className="text-xs text-muted-foreground">{formatFileSize(file.size)}</p>
										</div>
										<button
											type="button"
											onClick={() => removeFile(index)}
											className="text-muted-foreground hover:text-destructive transition-colors"
											aria-label={`Remove file ${index + 1}`}
										>
											✕
										</button>
									</div>
								)}
							</div>
						))}
					</div>
				</div>
			)}

			<div className="flex flex-col gap-3">
				{/* Input Area with Submit Button */}
				<div className="flex items-center gap-3">
					<div className="flex-1 relative">
						<TextAreaAutosize
							ref={textareaRef}
							value={message}
							onChange={(e) => setMessage(e.target.value)}
							onKeyDown={handleKeyDown}
							onPaste={handlePaste}
							onHeightChange={handleHeightChange}
							placeholder={isDragOver ? "Drop files here..." : "Ask Groq anything..."}
							className={cn(
								"w-full px-4 py-3 bg-transparent resize-none border-0 rounded-2xl text-foreground placeholder:text-muted-foreground focus:outline-none",
								// Control overflow based on whether we're at max height
								isAtMaxHeight ? "overflow-y-auto" : "overflow-y-hidden"
							)}
							style={{
								// Ensure smooth scrollbar appearance
								scrollbarWidth: 'thin',
								scrollbarGutter: 'stable'
							}}
							minRows={1}
							maxRows={10}
							cacheMeasurements={true}
						/>
						{/* Drag overlay */}
						{isDragOver && (
							<div className="absolute inset-0 bg-primary/10 border-2 border-dashed border-primary rounded-2xl flex items-center justify-center pointer-events-none">
								<div className="text-primary font-medium flex items-center gap-2">
									<ImagePlus className="w-5 h-5" />
									Drop files here
								</div>
							</div>
						)}
					</div>
					<div className="self-start">
						<Button
							type={loading ? "button" : "submit"}
							size="icon"
							className="h-12 w-12 rounded-2xl bg-primary hover:bg-primary/90 shadow-lg hover:shadow-xl transition-all duration-200 hover:scale-105"
							disabled={!loading && (!message.trim() && files.length === 0)}
							onClick={loading ? (e) => {
								e.preventDefault();
								onStopGeneration?.();
							} : undefined}
						>
							{loading ? (
								<Square className="w-5 h-5" aria-hidden="true" />
							) : (
								<ArrowUp className="w-5 h-5" aria-hidden="true" />
							)}
						</Button>
					</div>
				</div>

				{/* Bottom Controls */}
				<div className="flex flex-wrap items-center justify-between gap-y-2 px-2">
					<div className="flex flex-wrap items-center gap-2">
						{/* File Upload Button */}
						{files.length < 5 && (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() => fileInputRef.current?.click()}
								className="text-muted-foreground hover:text-foreground hover:bg-white/40 hover:shadow-sm transition-all duration-200 rounded-xl px-3 py-1.5"
								title={visionSupported ? "Upload file or image (max 5)" : "Upload files (images require vision-capable model)"}
								disabled={loading}
							>
								<ImagePlus className="w-4 h-4 mr-2" />
								Upload
							</Button>
						)}
						<input
							type="file"
							ref={fileInputRef}
							onChange={handleFileChange}
							accept={visionSupported ? "*/*" : ".txt,.md,.json,.csv,.xml,.html,.css,.js,.ts,.py,.java,.cpp,.c,.h,.log,.sql"}
							multiple
							style={{ display: "none" }}
							disabled={loading || files.length >= 5}
						/>

						{/* MCP Tools Button */}
						{onOpenMcpTools && (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={onOpenMcpTools}
								className="text-muted-foreground hover:text-foreground hover:bg-white/40 hover:shadow-sm transition-all duration-200 rounded-xl px-3 py-1.5"
								title="Open MCP tools panel"
								disabled={loading}
							>
								<Hammer className="w-4 h-4 mr-2" />
								Tools
							</Button>
						)}

						{/* Speech-to-Text Button or Recording Indicator */}
						{isRecording || isTranscribing ? (
							<div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-1.5 animate-pulse">
								<div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
								<span className="text-sm font-medium text-red-600 tabular-nums">
									{isTranscribing ? 'Processing...' : formattedDuration}
								</span>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={isRecording ? cancelRecording : undefined}
									className="p-1 h-6 w-6 text-red-600 hover:text-red-700 hover:bg-red-500/20 rounded-lg"
									title="Cancel recording"
									disabled={isTranscribing}
								>
									<X className="w-4 h-4" />
								</Button>
							</div>
						) : (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={toggleRecording}
								className="text-muted-foreground hover:text-foreground hover:bg-white/40 hover:shadow-sm transition-all duration-200 rounded-xl px-3 py-1.5"
								title={voiceAgent?.active ? "Voice input unavailable while the agent is listening" : "Voice input (or hold Space)"}
								disabled={loading || voiceAgent?.active}
							>
								<Mic className="w-4 h-4 mr-2" />
								Voice
							</Button>
						)}

						{/* Voice Agent (local Kokoro TTS + VAD turn detection) */}
						{voiceAgent?.supported && (
							voiceAgent.active && agentStateInfo ? (
								<div
									className={cn("flex items-center gap-2 border rounded-xl px-3 py-1.5", agentStateInfo.cls)}
									title={voiceAgent.ttsStatus?.detail || "Voice agent running"}
								>
									{voiceAgent.agentState === 'starting' ? (
										<Loader2 className="w-3.5 h-3.5 animate-spin" />
									) : (
										<div className={cn("w-2 h-2 rounded-full", agentStateInfo.dot)} />
									)}
									<span className="text-sm font-medium">{agentStateInfo.label}{voiceAgent.muted ? ' · muted' : ''}</span>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										onClick={voiceAgent.toggleMute}
										className="p-1 h-6 w-6 hover:bg-black/10 rounded-lg"
										title={voiceAgent.muted ? "Unmute — speak replies aloud" : "Mute — replies stay text-only"}
									>
										{voiceAgent.muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
									</Button>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										onClick={voiceAgent.stop}
										className="p-1 h-6 w-6 hover:bg-black/10 rounded-lg"
										title="Stop voice agent"
									>
										<X className="w-4 h-4" />
									</Button>
								</div>
							) : (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={voiceAgent.start}
									className="text-muted-foreground hover:text-foreground hover:bg-white/40 hover:shadow-sm transition-all duration-200 rounded-xl px-3 py-1.5"
									title="Start a voice conversation (local Kokoro TTS)"
								>
									<AudioLines className="w-4 h-4 mr-2" />
									Agent
								</Button>
							)
						)}

						{/* Screenshare (voice agent sessions only) */}
						{capture && voiceAgent?.active && (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={capture.toggleScreenshare}
								className={cn(
									"transition-all duration-200 rounded-xl px-3 py-1.5",
									capture.mode === 'screen'
										? "bg-primary/15 text-primary hover:bg-primary/20"
										: "text-muted-foreground hover:text-foreground hover:bg-white/40 hover:shadow-sm"
								)}
								title={!visionSupported ? "Screen share requires a vision-capable model" : capture.mode === 'screen' ? "Stop sharing screen" : "Share a screen or window with the model"}
								disabled={!visionSupported}
							>
								<Monitor className="w-4 h-4" />
							</Button>
						)}

						{/* Camera (voice agent sessions only) */}
						{capture && voiceAgent?.active && (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={capture.toggleCamera}
								className={cn(
									"transition-all duration-200 rounded-xl px-3 py-1.5",
									capture.mode === 'camera'
										? "bg-primary/15 text-primary hover:bg-primary/20"
										: "text-muted-foreground hover:text-foreground hover:bg-white/40 hover:shadow-sm"
								)}
								title={!visionSupported ? "Camera requires a vision-capable model" : capture.mode === 'camera' ? "Turn camera off" : "Share your camera with the model"}
								disabled={!visionSupported}
							>
								<Camera className="w-4 h-4" />
							</Button>
						)}

						{/* Live capture preview */}
						{capture?.mode && voiceAgent?.active && (
							<video
								ref={capturePreviewRef}
								muted
								playsInline
								autoPlay
								className="h-8 w-14 rounded-md object-cover border border-border/50 bg-black/80"
								title={capture.mode === 'screen' ? "Sharing screen — a frame is attached to each message" : "Camera on — a frame is attached to each message"}
							/>
						)}
					</div>

					<div className="flex flex-wrap items-center gap-3">
						{/* Autocomplete hint */}
						{autocompleteEnabled && suggestion && !loading && (
							<div className="text-xs text-muted-foreground flex items-center gap-1">
								<kbd className="px-1.5 py-0.5 text-xs bg-muted border rounded">Tab</kbd>
								to accept
							</div>
						)}
						
						{/* Reasoning Effort Selector (only for models that support it) */}
						{effortOptions.length > 0 && (
							<SearchableSelect
								value={effortOptions.includes(reasoningEffort) ? reasoningEffort : effortOptions[0]}
								onValueChange={onReasoningEffortChange}
								options={effortOptions}
								placeholder="Effort"
								className="w-28"
								disabled={loading}
								getDisplayValue={(value) => getEffortLabel(value)}
								getOptionLabel={(level) => getEffortLabel(level)}
								getOptionValue={(level) => level}
							/>
						)}

						{/* Model Selector */}
						<SearchableSelect
							value={selectedModel}
							onValueChange={onModelChange}
							options={sortedModels}
							placeholder="Select model"
							className="w-48"
							disabled={loading}
							getDisplayValue={(value) => getModelDisplayName(value)}
							getOptionLabel={(model) => getModelDisplayName(model)}
							getOptionValue={(model) => model}
						/>
					</div>
				</div>
			</div>
		</form>

		{/* Fullscreen Image Modal */}
		{fullScreenImage && (
			<div 
				className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 p-4 cursor-pointer"
				onClick={() => setFullScreenImage(null)}
			>
				<img 
					src={fullScreenImage} 
					alt="Fullscreen preview" 
					className="max-w-full max-h-full object-contain"
					onClick={(e) => e.stopPropagation()}
				/>
				<button
					onClick={() => setFullScreenImage(null)}
					className="absolute top-4 right-4 bg-black bg-opacity-50 text-white rounded-full w-10 h-10 flex items-center justify-center hover:bg-opacity-70 transition-all"
					aria-label="Close fullscreen image"
				>
					✕
				</button>
			</div>
		)}
    </div>
	);
}

export default ChatInput;
