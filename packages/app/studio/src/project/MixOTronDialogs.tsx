import {createElement} from "@opendaw/lib-jsx"
import {Errors, Option} from "@opendaw/lib-std"
import {IconSymbol} from "@opendaw/studio-enums"
import {Dialog} from "@/ui/components/Dialog"
import {Surface} from "@/ui/surface/Surface"
import {Dialogs} from "@/ui/components/dialogs"

export type MixOTronCredentials = { baseUrl: string, token: string }

// Trailing paths people paste instead of the bare origin — the /dashboard/link page shows the
// Link token next to the "Endpoint URL", so both are equally easy to copy by mistake.
const KnownTrailingPaths = ["/api/link/upload", "/dashboard/link"]

const normalizeBaseUrl = (raw: string): string => {
    let url = raw.trim().replace(/\/+$/, "")
    for (const path of KnownTrailingPaths) {
        if (url.endsWith(path)) {url = url.slice(0, -path.length)}
    }
    return url.replace(/\/+$/, "")
}

export namespace MixOTronDialogs {
    const BaseUrlKey = "mixotron.server-url"
    const TokenKey = "mixotron.link-token"

    export const getStoredCredentials = (): Option<MixOTronCredentials> => {
        const baseUrl = localStorage.getItem(BaseUrlKey)
        const token = localStorage.getItem(TokenKey)
        return baseUrl === null || token === null ? Option.None : Option.wrap({baseUrl, token})
    }

    export const forget = (): void => {
        localStorage.removeItem(BaseUrlKey)
        localStorage.removeItem(TokenKey)
    }

    export const ensureConnection = async (): Promise<Option<MixOTronCredentials>> => {
        const stored = getStoredCredentials()
        return stored.nonEmpty() ? stored : Option.async(showCredentialsDialog())
    }

    export const showUploadSuccess = (url: string): Promise<void> => Dialogs.show({
        headline: "Uploaded to Mix-O-Tron",
        content: (<p>Continue authoring the Content Credential at <a href={url} target="_blank" rel="noreferrer">{url}</a>.</p>),
        okText: "Ok"
    })

    export const showCredentialsDialog = (): Promise<MixOTronCredentials> => {
        const {resolve, reject, promise} = Promise.withResolvers<MixOTronCredentials>()
        const inputUrl: HTMLInputElement =
            <input className="default" type="text" autocomplete="url" value={localStorage.getItem(BaseUrlKey) ?? ""}
                   placeholder="https://your-mixotron-instance"/>
        const inputToken: HTMLInputElement =
            <input className="default" type="password" autocomplete="off" value={localStorage.getItem(TokenKey) ?? ""}
                   placeholder="Link token"/>
        const approve = () => {
            const baseUrl = normalizeBaseUrl(inputUrl.value)
            const token = inputToken.value.trim()
            if (baseUrl.length === 0 || token.length === 0) {
                Dialogs.info({headline: "Missing input", message: "Server URL and Link token are required."}).finally()
                return false
            }
            localStorage.setItem(BaseUrlKey, baseUrl)
            localStorage.setItem(TokenKey, token)
            resolve({baseUrl, token})
            return true
        }
        const dialog: HTMLDialogElement = (
            <Dialog headline="Connect to Mix-O-Tron"
                    icon={IconSymbol.Share}
                    cancelable={true}
                    onCancel={() => reject(Errors.AbortError)}
                    buttons={[
                        {text: "Close", onClick: handler => handler.close()},
                        {text: "Connect", primary: true, onClick: handler => {if (approve()) {handler.close()}}}
                    ]}>
                <form style={{
                    padding: "1em 0", display: "grid", gridTemplateColumns: "auto 1fr",
                    columnGap: "1em", rowGap: "0.5em"
                }} onsubmit={event => {
                    event.preventDefault()
                    if (approve()) {dialog.close()}
                }}>
                    <div>Server URL:</div>
                    {inputUrl}
                    <div>Link Token:</div>
                    {inputToken}
                </form>
            </Dialog>
        )
        dialog.onkeydown = event => {if (event.code === "Enter") {if (approve()) {dialog.close()}}}
        Surface.get().flyout.appendChild(dialog)
        dialog.showModal()
        const focusTarget = inputUrl.value.length === 0 ? inputUrl : inputToken
        focusTarget.focus()
        return promise
    }
}
