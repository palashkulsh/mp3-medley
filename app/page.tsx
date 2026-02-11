"use client";

import { createFFmpeg, fetchFile } from "@ffmpeg/ffmpeg";
import { useEffect, useMemo, useRef, useState } from "react";

type Track = {
  id: string;
  file?: File;
  url?: string;
  name?: string;
  start: number;
  end: number;
  fadeIn: number;
  fadeOut: number;
  startText: string;
  endText: string;
  fadeInText: string;
  fadeOutText: string;
  duration?: number;
};

const createEmptyTrack = (): Track => ({
  id: crypto.randomUUID(),
  start: 0,
  end: 0,
  fadeIn: 0,
  fadeOut: 0,
  startText: "00:00:00",
  endText: "00:00:00",
  fadeInText: "00:00:00",
  fadeOutText: "00:00:00"
});

const clampNumber = (value: number, min = 0) =>
  Number.isFinite(value) ? Math.max(value, min) : min;

const formatTime = (value?: number) => {
  if (!value || !Number.isFinite(value)) {
    return "00:00:00";
  }
  const total = Math.max(0, Math.floor(value));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
};

const parseTime = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parts = trimmed.split(":").map((part) => part.trim());
  if (parts.some((part) => part === "" || Number.isNaN(Number(part)))) {
    return null;
  }
  if (parts.length > 3) {
    return null;
  }
  const numbers = parts.map((part) => Number(part));
  const [hours, minutes, seconds] =
    numbers.length === 3
      ? [numbers[0], numbers[1], numbers[2]]
      : numbers.length === 2
        ? [0, numbers[0], numbers[1]]
        : [0, 0, numbers[0]];
  if (
    hours < 0 ||
    minutes < 0 ||
    seconds < 0 ||
    minutes >= 60 ||
    seconds >= 60
  ) {
    return null;
  }
  return hours * 3600 + minutes * 60 + seconds;
};

export default function Home() {
  const [tracks, setTracks] = useState<Track[]>([createEmptyTrack()]);
  const [ffmpegReady, setFfmpegReady] = useState(false);
  const [ffmpegStatus, setFfmpegStatus] = useState("Loading ffmpeg...");
  const [isProcessing, setIsProcessing] = useState(false);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [previewElapsed, setPreviewElapsed] = useState(0);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isPreviewPaused, setIsPreviewPaused] = useState(false);
  const ffmpegRef = useRef<ReturnType<typeof createFFmpeg> | null>(null);
  const previewRef = useRef<HTMLAudioElement | null>(null);
  const tracksRef = useRef<Track[]>([]);
  const coreBlobUrlsRef = useRef<string[]>([]);
  const previewSequenceRef = useRef(false);
  const previewSegmentsRef = useRef<Track[]>([]);
  const previewIndexRef = useRef(0);
  const previewElapsedRef = useRef(0);

  const previewLength = useMemo(
    () =>
      tracks.reduce((total, track) => {
        if (!track.url || track.end <= track.start) {
          return total;
        }
        return total + Math.max(track.end - track.start, 0);
      }, 0),
    [tracks]
  );

  useEffect(() => {
    tracksRef.current = tracks;
  }, [tracks]);

  useEffect(() => {
    return () => {
      if (outputUrl) {
        URL.revokeObjectURL(outputUrl);
      }
    };
  }, [outputUrl]);

  useEffect(() => {
    let mounted = true;
    const loadFfmpeg = async () => {
      try {
        const baseUrl = "https://unpkg.com/@ffmpeg/core@0.11.0/dist";
        const toBlobURL = async (url: string, type: string) => {
          const response = await fetch(url);
          if (!response.ok) {
            throw new Error(`Failed to fetch ${url}`);
          }
          const blob = await response.blob();
          const blobUrl = URL.createObjectURL(new Blob([blob], { type }));
          coreBlobUrlsRef.current.push(blobUrl);
          return blobUrl;
        };

        const [corePath, wasmPath, workerPath] = await Promise.all([
          toBlobURL(`${baseUrl}/ffmpeg-core.js`, "text/javascript"),
          toBlobURL(`${baseUrl}/ffmpeg-core.wasm`, "application/wasm"),
          toBlobURL(`${baseUrl}/ffmpeg-core.worker.js`, "text/javascript")
        ]);

        const ffmpeg = createFFmpeg({
          log: true,
          corePath,
          wasmPath,
          workerPath
        });
        ffmpegRef.current = ffmpeg;
        await ffmpeg.load();
        if (mounted) {
          setFfmpegReady(true);
          setFfmpegStatus("FFmpeg ready");
        }
      } catch (error) {
        console.error(error);
        if (mounted) {
          setFfmpegStatus("Failed to load FFmpeg");
        }
      }
    };

    loadFfmpeg();

    return () => {
      mounted = false;
      previewRef.current?.pause();
      previewRef.current = null;
      tracksRef.current.forEach((track) => {
        if (track.url) {
          URL.revokeObjectURL(track.url);
        }
      });
      coreBlobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      coreBlobUrlsRef.current = [];
    };
  }, []);

  const canJoin = useMemo(
    () =>
      tracks.length > 0 &&
      tracks.every(
        (track) =>
          track.file &&
          track.end > track.start &&
          track.end > 0 &&
          track.start >= 0
      ),
    [tracks]
  );

  const updateTrack = (id: string, updates: Partial<Track>) => {
    setTracks((current) =>
      current.map((track) => (track.id === id ? { ...track, ...updates } : track))
    );
  };

  const updateTimeField = (
    id: string,
    field: "start" | "end" | "fadeIn" | "fadeOut",
    value: string
  ) => {
    const parsed = parseTime(value);
    setTracks((current) =>
      current.map((track) => {
        if (track.id !== id) {
          return track;
        }
        const next: Track = {
          ...track,
          [`${field}Text`]: value
        } as Track;
        if (parsed !== null) {
          next[field] = clampNumber(parsed);
        }
        return next;
      })
    );
  };

  const handleFileChange = async (id: string, file?: File | null) => {
    if (!file) {
      setTracks((current) =>
        current.map((track) => {
          if (track.id !== id) {
            return track;
          }
          if (track.url) {
            URL.revokeObjectURL(track.url);
          }
          return { ...track, file: undefined, url: undefined, name: undefined };
        })
      );
      return;
    }
    const url = URL.createObjectURL(file);
    setTracks((current) =>
      current.map((track) => {
        if (track.id !== id) {
          return track;
        }
        if (track.url) {
          URL.revokeObjectURL(track.url);
        }
        return {
          ...track,
          file,
          url,
          name: file.name
        };
      })
    );
    const audio = new Audio(url);
    audio.preload = "metadata";
    audio.addEventListener("loadedmetadata", () => {
      const duration = clampNumber(audio.duration);
      setTracks((current) =>
        current.map((track) =>
          track.id === id
            ? {
                ...track,
                duration,
                end: track.end > 0 ? Math.min(track.end, duration) : duration,
                endText: formatTime(
                  track.end > 0 ? Math.min(track.end, duration) : duration
                )
              }
            : track
        )
      );
    });
  };

  const addTrack = () => {
    setTracks((current) => [...current, createEmptyTrack()]);
  };

  const removeTrack = (id: string) => {
    setTracks((current) => {
      const track = current.find((item) => item.id === id);
      if (track?.url) {
        URL.revokeObjectURL(track.url);
      }
      return current.filter((item) => item.id !== id);
    });
  };

  const moveTrack = (index: number, direction: -1 | 1) => {
    setTracks((current) => {
      const next = [...current];
      const targetIndex = index + direction;
      if (targetIndex < 0 || targetIndex >= next.length) {
        return current;
      }
      const [moved] = next.splice(index, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  };

  const stopPreview = () => {
    if (previewRef.current) {
      previewRef.current.pause();
      previewRef.current = null;
    }
    previewSequenceRef.current = false;
    previewSegmentsRef.current = [];
    previewIndexRef.current = 0;
    previewElapsedRef.current = 0;
    setPreviewElapsed(0);
    setIsPreviewing(false);
    setIsPreviewPaused(false);
  };

  const previewTrack = (track: Track) => {
    if (!track.url || track.end <= track.start) {
      return;
    }
    stopPreview();
    const audio = new Audio(track.url);
    previewRef.current = audio;
    audio.currentTime = clampNumber(track.start);
    const stopAt = clampNumber(track.end);
    const handleTimeUpdate = () => {
      if (audio.currentTime >= stopAt) {
        audio.pause();
        audio.removeEventListener("timeupdate", handleTimeUpdate);
      }
    };
    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.play().catch(() => undefined);
  };

  const previewSequence = () => {
    const validTracks = tracks.filter(
      (track) => track.url && track.end > track.start
    );
    if (validTracks.length === 0) {
      return;
    }
    stopPreview();
    previewSequenceRef.current = true;
    previewSegmentsRef.current = validTracks;
    previewIndexRef.current = 0;
    previewElapsedRef.current = 0;
    setPreviewElapsed(0);
    setIsPreviewing(true);
    setIsPreviewPaused(false);
    const audio = new Audio();
    previewRef.current = audio;

    const playSegment = (index: number) => {
      const track = validTracks[index];
      if (!track.url || !previewSequenceRef.current) {
        return;
      }
      audio.pause();
      audio.src = track.url;
      const start = clampNumber(track.start);
      const end = clampNumber(track.end);

      const handleTimeUpdate = () => {
        const elapsed = previewElapsedRef.current + Math.max(audio.currentTime - start, 0);
        setPreviewElapsed(elapsed);
        if (audio.currentTime >= end) {
          audio.removeEventListener("timeupdate", handleTimeUpdate);
          previewElapsedRef.current += Math.max(end - start, 0);
          if (index + 1 < validTracks.length) {
            playSegment(index + 1);
          } else {
            audio.pause();
            previewSequenceRef.current = false;
            setIsPreviewing(false);
            setIsPreviewPaused(false);
          }
        }
      };

      const handleLoaded = () => {
        audio.currentTime = start;
        audio.play().catch(() => undefined);
      };

      audio.addEventListener("timeupdate", handleTimeUpdate);
      audio.addEventListener("loadedmetadata", handleLoaded, { once: true });
    };

    playSegment(0);
  };

  const pausePreview = () => {
    if (previewRef.current && isPreviewing && !isPreviewPaused) {
      previewRef.current.pause();
      setIsPreviewPaused(true);
    }
  };

  const resumePreview = () => {
    if (previewRef.current && isPreviewing && isPreviewPaused) {
      previewRef.current.play().catch(() => undefined);
      setIsPreviewPaused(false);
    }
  };

  const joinTracks = async () => {
    if (!ffmpegRef.current || !canJoin) {
      return;
    }
    setIsProcessing(true);
    setOutputUrl(null);
    const ffmpeg = ffmpegRef.current;

    try {
      const inputNames: string[] = [];
      for (const track of tracks) {
        if (!track.file) {
          continue;
        }
        const safeName = `input-${track.id}.mp3`;
        inputNames.push(safeName);
        ffmpeg.FS("writeFile", safeName, await fetchFile(track.file));
      }

      const filterParts: string[] = [];
      const concatInputs: string[] = [];

      tracks.forEach((track, index) => {
        if (!track.file) {
          return;
        }
        const duration = clampNumber(track.end - track.start);
        const filters = [
          `[${index}:a]atrim=start=${track.start}:end=${track.end}`,
          "asetpts=PTS-STARTPTS"
        ];
        if (track.fadeIn > 0) {
          filters.push(`afade=t=in:st=0:d=${track.fadeIn}`);
        }
        if (track.fadeOut > 0 && duration > track.fadeOut) {
          const fadeStart = Math.max(duration - track.fadeOut, 0).toFixed(3);
          filters.push(`afade=t=out:st=${fadeStart}:d=${track.fadeOut}`);
        }
        const label = `a${index}`;
        filterParts.push(`${filters.join(",")}[${label}]`);
        concatInputs.push(`[${label}]`);
      });

      const filterComplex = `${filterParts.join(";")};${concatInputs.join("")}concat=n=${
        concatInputs.length
      }:v=0:a=1[outa]`;

      try {
        ffmpeg.FS("unlink", "medley.mp3");
      } catch {
        // ignore missing file
      }

      await ffmpeg.run(
        ...inputNames.flatMap((name) => ["-i", name]),
        "-filter_complex",
        filterComplex,
        "-map",
        "[outa]",
        "-c:a",
        "libmp3lame",
        "-q:a",
        "2",
        "medley.mp3"
      );

      const data = ffmpeg.FS("readFile", "medley.mp3");
      const safeBuffer = new Uint8Array(data).buffer;
      const blob = new Blob([safeBuffer], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      setOutputUrl(url);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <main>
      <h1>MP3 Medley Maker</h1>
      <p>
        Upload MP3s, trim sections, add fades, and merge them into a single
        medley in your preferred order.
      </p>

      <div className="panel">
        <h2>Tracks</h2>
        <div className="helper">{ffmpegStatus}</div>
        {tracks.map((track, index) => (
          <div key={track.id} className="track">
            <div>
              <div className="label">MP3 file</div>
              <input
                type="file"
                accept="audio/mpeg"
                onChange={(event) =>
                  handleFileChange(track.id, event.target.files?.[0] ?? null)
                }
              />
              <div className="helper">
                {track.name ?? "No file selected"}
              </div>
              <div className="helper">Duration: {formatTime(track.duration)}</div>
            </div>
            <div>
              <div className="label">Start (hh:mm:ss)</div>
              <input
                type="text"
                value={track.startText}
                onChange={(event) =>
                  updateTimeField(track.id, "start", event.target.value)
                }
              />
            </div>
            <div>
              <div className="label">End (hh:mm:ss)</div>
              <input
                type="text"
                value={track.endText}
                onChange={(event) =>
                  updateTimeField(track.id, "end", event.target.value)
                }
              />
            </div>
            <div>
              <div className="label">Fade in (hh:mm:ss)</div>
              <input
                type="text"
                value={track.fadeInText}
                onChange={(event) =>
                  updateTimeField(track.id, "fadeIn", event.target.value)
                }
              />
            </div>
            <div>
              <div className="label">Fade out (hh:mm:ss)</div>
              <input
                type="text"
                value={track.fadeOutText}
                onChange={(event) =>
                  updateTimeField(track.id, "fadeOut", event.target.value)
                }
              />
            </div>
            <div>
              <div className="label">Preview</div>
              <div className="track-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => previewTrack(track)}
                  disabled={!track.url}
                >
                  Play
                </button>
                <button type="button" className="ghost" onClick={stopPreview}>
                  Stop
                </button>
              </div>
            </div>
            <div className="track-actions">
              <button
                type="button"
                className="ghost"
                onClick={() => moveTrack(index, -1)}
                disabled={index === 0}
              >
                ↑
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => moveTrack(index, 1)}
                disabled={index === tracks.length - 1}
              >
                ↓
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => removeTrack(track.id)}
                disabled={tracks.length === 1}
              >
                Remove
              </button>
            </div>
          </div>
        ))}

        <div className="row">
          <button type="button" className="secondary" onClick={addTrack}>
            Add another MP3
          </button>
          <button
            type="button"
            className="secondary"
            onClick={previewSequence}
            disabled={!tracks.some((track) => track.url && track.end > track.start)}
          >
            Play medley preview
          </button>
          <button
            type="button"
            className="secondary"
            onClick={pausePreview}
            disabled={!isPreviewing || isPreviewPaused}
          >
            Pause preview
          </button>
          <button
            type="button"
            className="secondary"
            onClick={resumePreview}
            disabled={!isPreviewing || !isPreviewPaused}
          >
            Resume preview
          </button>
          <button
            type="button"
            className="secondary"
            onClick={stopPreview}
            disabled={!isPreviewing}
          >
            Stop preview
          </button>
          <div className="helper">
            Preview length: {formatTime(previewLength)} · Played: {formatTime(previewElapsed)}
          </div>
          <button
            type="button"
            onClick={joinTracks}
            disabled={!ffmpegReady || isProcessing || !canJoin}
          >
            {isProcessing ? "Joining..." : "Join tracks"}
          </button>
        </div>
      </div>

      <div className="panel">
        <h2>Output</h2>
        {outputUrl ? (
          <div className="output">
            <audio controls src={outputUrl} />
            <a href={outputUrl} download="medley.mp3">
              <button type="button">Download MP3</button>
            </a>
          </div>
        ) : null}
      </div>
    </main>
  );
}
