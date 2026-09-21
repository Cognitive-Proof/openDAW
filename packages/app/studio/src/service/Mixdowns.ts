import {assert, DefaultObservableValue, Errors, Option, RuntimeNotifier, UUID} from "@opendaw/lib-std"
import {AudioData, WavFile} from "@opendaw/lib-dsp"
import {
    ExternalLib,
    FFmpegConverter,
    FFmpegWorker,
    OfflineEngineRenderer,
    Project,
    ProjectMeta,
    ProjectProfile,
    SampleStorage,
    Workers
} from "@opendaw/studio-core"
import {Files} from "@opendaw/lib-dom"
import {Promises} from "@opendaw/lib-runtime"
import {ExportConfiguration, SampleLoader} from "@opendaw/studio-adapters"
import {AudioFileBox} from "@opendaw/studio-boxes"
import {Dialogs} from "@/ui/components/dialogs"
import {MixOTronCredentials, MixOTronDialogs} from "@/project/MixOTronDialogs"

export namespace Mixdowns {
    export const exportMixdown = async ({project: source, meta}: ProjectProfile): Promise<void> => {
        const project = source.copy()
        const abortController = new AbortController()
        const progress = new DefaultObservableValue(0.0)
        const dialog = RuntimeNotifier.progress({
            headline: "Rendering mixdown...",
            progress,
            cancel: () => abortController.abort()
        })
        const result = await Promises.tryCatch(OfflineEngineRenderer
            .start(project, Option.None, progress, abortController.signal, 48_000))
        dialog.terminate()
        if (result.status === "rejected") {
            if (!Errors.isAbort(result.error)) {
                throw result.error
            }
            return
        }
        const audioData: AudioData = result.value
        const {resolve, reject, promise} = Promise.withResolvers<void>()
        const {status, error} = await Promises.tryCatch(Dialogs.show({
            headline: "Encode Mixdown",
            content: "openDAW will download FFmpeg (30MB) once to encode your mixdown unless you choose 'Wav'.",
            excludeOk: true,
            buttons: [
                {
                    text: "Mp3", onClick: handler => {
                        handler.close()
                        saveMp3File(audioData, meta).then(resolve, reject)
                    }, primary: false
                }, {
                    text: "Flac", onClick: handler => {
                        handler.close()
                        saveFlacFile(audioData, meta).then(resolve, reject)
                    }, primary: false
                }, {
                    text: "Wav", onClick: handler => {
                        handler.close()
                        saveWavFile(audioData, meta).then(resolve, reject)
                    }, primary: true
                }
            ]
        }))
        if (status === "rejected" && !Errors.isAbort(error)) {
            reject(error)
            return
        }
        return promise
    }

    export const exportStems = async ({project: source, meta}: ProjectProfile,
                                      config: ExportConfiguration): Promise<void> => {
        const project = source.copy()
        const abortController = new AbortController()
        const progress = new DefaultObservableValue(0.0)
        const dialog = RuntimeNotifier.progress({
            headline: "Rendering mixdown...",
            progress,
            cancel: () => abortController.abort()
        })
        const {status, value, error: renderError} = await Promises.tryCatch(OfflineEngineRenderer
            .start(project, Option.wrap(config), progress, abortController.signal, 48_000))
        dialog.terminate()
        if (status === "rejected") {
            if (Errors.isAbort(renderError)) {return}
            console.warn(renderError)
            RuntimeNotifier.notify({message: "Export failed.", icon: "Warning"})
            return
        }
        const {status: zipStatus, error: zipError} = await Promises.tryCatch(
            saveZipFile(value, meta, ExportConfiguration.stemFileNames(config)))
        if (zipStatus === "rejected") {
            console.warn(zipError)
            RuntimeNotifier.notify({message: "Export failed.", icon: "Warning"})
            return
        }
    }

    export type Ingredient = { name: string, sha256: string }

    export const uploadToMixOTron = async ({project: source, meta}: ProjectProfile): Promise<string> => {
        const credentials = await MixOTronDialogs.ensureConnection()
        if (credentials.isEmpty()) {throw Errors.AbortError}
        const project = source.copy()
        const abortController = new AbortController()
        const progress = new DefaultObservableValue(0.0)
        const dialog = RuntimeNotifier.progress({
            headline: "Rendering mixdown...",
            progress,
            cancel: () => abortController.abort()
        })
        const result = await Promises.tryCatch(OfflineEngineRenderer
            .start(project, Option.None, progress, abortController.signal, 48_000))
        dialog.terminate()
        if (result.status === "rejected") {throw result.error}
        const wav = WavFile.encodeFloats(result.value)
        const hashDialog = RuntimeNotifier.progress({headline: "Hashing ingredients..."})
        const ingredientsResult = await Promises.tryCatch(hashIngredients(project))
        hashDialog.terminate()
        if (ingredientsResult.status === "rejected") {throw ingredientsResult.error}
        return uploadMixdown(credentials.unwrap(), wav, meta.name, ingredientsResult.value)
    }

    const hashIngredients = async (project: Project): Promise<ReadonlyArray<Ingredient>> => {
        const audioFileBoxes = project.boxGraph.boxes().filter(box => box instanceof AudioFileBox)
        return Promise.all(audioFileBoxes.map(async ({address: {uuid}}) => {
            const loader: SampleLoader = project.sampleManager.getOrCreate(uuid)
            await awaitSampleLoaded(loader)
            const path = `${SampleStorage.Folder}/${UUID.toString(uuid)}/audio.wav`
            const [bytes, sampleMeta] = await Promise.all([Workers.Opfs.read(path), SampleStorage.get().loadMeta(uuid)])
            const digest = await crypto.subtle.digest("SHA-256",
                bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
            const sha256 = Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("")
            return {name: sampleMeta.name, sha256}
        }))
    }

    const awaitSampleLoaded = (loader: SampleLoader): Promise<void> =>
        loader.state.type === "loaded" ? Promise.resolve() : new Promise<void>((resolve, reject) => {
            const subscription = loader.subscribe(state => {
                if (state.type === "loaded") {
                    resolve()
                    subscription.terminate()
                } else if (state.type === "error") {
                    reject(new Error(state.reason))
                    subscription.terminate()
                }
            })
        })

    const uploadMixdown = async ({baseUrl, token}: MixOTronCredentials, wav: ArrayBuffer, name: string,
                                 ingredients: ReadonlyArray<Ingredient>): Promise<string> => {
        const formData = new FormData()
        formData.append("file", new Blob([wav], {type: "audio/wav"}), `${name}.wav`)
        formData.append("name", name)
        if (ingredients.length > 0) {formData.append("ingredients", JSON.stringify(ingredients))}
        const progress = new DefaultObservableValue(0.0)
        const dialog = RuntimeNotifier.progress({headline: "Uploading to Mix-O-Tron...", progress})
        const {resolve, reject, promise} = Promise.withResolvers<string>()
        const xhr = new XMLHttpRequest()
        xhr.upload.addEventListener("progress", event => {
            if (event.lengthComputable) {progress.setValue(event.loaded / event.total)}
        })
        xhr.addEventListener("load", () => {
            if (xhr.status === 200 || xhr.status === 201) {
                const response = JSON.parse(xhr.responseText)
                resolve(response.url)
            } else {
                console.warn(xhr.status, xhr.responseText)
                const error = JSON.parse(xhr.responseText)
                reject(new Error(error.error || "Upload failed"))
            }
        })
        xhr.addEventListener("error", () => reject(new Error("Network error")))
        xhr.open("POST", `${baseUrl}/api/link/upload`)
        xhr.setRequestHeader("Authorization", `Bearer ${token}`)
        xhr.send(formData)
        return promise.finally(() => dialog.terminate())
    }

    const saveWavFile = async (audioData: AudioData, meta: ProjectMeta) => {
        return Files.saveWithApproval({
            buffer: WavFile.encodeFloats(audioData),
            headline: "Save Wav",
            suggestedName: `${meta.name}.wav`
        })
    }

    const saveMp3File = async (audioData: AudioData, meta: ProjectMeta) => {
        const ffmpeg = await loadFFmepg()
        return encodeAndSaveFile({
            converter: ffmpeg.mp3Converter(),
            fileExtension: "mp3",
            fileType: "Mp3",
            fileName: meta.name,
            audioData
        })
    }

    const saveFlacFile = async (audioData: AudioData, meta: ProjectMeta) => {
        const ffmpeg = await loadFFmepg()
        return encodeAndSaveFile({
            converter: ffmpeg.flacConverter(),
            fileExtension: "flac",
            fileType: "Flac",
            fileName: meta.name,
            audioData
        })
    }

    const encodeAndSaveFile = async ({audioData, converter, fileType, fileExtension, fileName}: {
        audioData: AudioData,
        converter: FFmpegConverter<unknown>,
        fileType: string,
        fileExtension: string,
        fileName: string
    }) => {
        const progress = new DefaultObservableValue(0.0)
        const progressDialog = RuntimeNotifier.progress({headline: `Encoding ${fileType}...`, progress})
        const flac = await converter.convert(new Blob([WavFile.encodeFloats(audioData)]),
            value => progress.setValue(value))
        progressDialog.terminate()
        return Files.saveWithApproval({
            buffer: flac,
            headline: `Save ${fileType}`,
            suggestedName: `${fileName}.${fileExtension}`
        })
    }

    const saveZipFile = async (audioData: AudioData, meta: ProjectMeta, trackNames: ReadonlyArray<string>) => {
        const libResult = await ExternalLib.JSZip()
        if (libResult.status === "rejected") {
            console.warn(libResult.error)
            RuntimeNotifier.notify({message: "Could not load JSZip.", icon: "Warning"})
            return Promise.reject(libResult.error)
        }
        const dialog = RuntimeNotifier.progress({headline: "Creating Zip File..."})
        const numStems = audioData.numberOfChannels >> 1
        // One name per rendered pair, or `trackNames[stemIndex]` quietly yields undefined and writes
        // "undefined.wav" instead of failing (which is exactly what a missing metronome name did).
        assert(trackNames.length === numStems,
            () => `Expected ${numStems} stem names for the rendered pairs, got ${trackNames.length}`)
        const zip = new libResult.value()
        for (let stemIndex = 0; stemIndex < numStems; stemIndex++) {
            const l = audioData.frames[stemIndex * 2]
            const r = audioData.frames[stemIndex * 2 + 1]
            const stemData = AudioData.create(audioData.sampleRate, audioData.numberOfFrames, 2)
            stemData.frames[0].set(l)
            stemData.frames[1].set(r)
            const file = WavFile.encodeFloats(stemData)
            zip.file(`${trackNames[stemIndex]}.wav`, file, {binary: true})
        }
        const {status, value: arrayBuffer, error} = await Promises.tryCatch(zip.generateAsync({
            type: "arraybuffer",
            compression: "DEFLATE",
            compressionOptions: {level: 6}
        }))
        dialog.terminate()
        if (status === "rejected") {
            console.warn(error)
            RuntimeNotifier.notify({message: "Could not create zip.", icon: "Warning"})
            return
        }
        return Files.saveWithApproval({
            buffer: arrayBuffer,
            headline: "Save Zip",
            message: `Size: ${arrayBuffer.byteLength >> 20}M`,
            suggestedName: `${meta.name}.zip`
        })
    }

    const loadFFmepg = async (): Promise<FFmpegWorker> => {
        const {FFmpegWorker} = await Promises.guardedRetry(() =>
            import("@opendaw/studio-core/FFmpegWorker"), (_, count) => count < 60)
        const progress = new DefaultObservableValue(0.0)
        const progressDialog = RuntimeNotifier.progress({headline: "Loading FFmpeg...", progress})
        const {status, value, error} = await Promises.tryCatch(FFmpegWorker.load(value => progress.setValue(value)))
        progressDialog.terminate()
        if (status === "rejected") {
            console.warn(error)
            RuntimeNotifier.notify({message: "Could not load FFmpeg.", icon: "Warning"})
            throw error
        }
        return value
    }
}