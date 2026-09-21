# Smart Pet Life：自行產生 Android APK

本文件說明如何依目前專案設定產生可直接安裝到 Android 手機或模擬器的 APK。專案目前使用 Expo SDK 54 與 EAS Build，建議在 Windows 上使用 EAS 雲端建置。

> APK 適合內部測試與直接安裝；要上架 Google Play 時應建立 AAB，而不是使用本文件的 preview APK。

## 目前專案設定

- Expo 帳號：`softjoywander`
- EAS Project ID：`47793d4b-f596-4148-96f4-b0e8820f10bf`
- Android Package：`life.smartpet.app`
- 建置設定：`mobile/eas.json` 的 `preview`
- 輸出格式：APK
- EAS 環境：`preview`

目前 `eas.json` 已包含：

```json
{
  "build": {
    "preview": {
      "distribution": "internal",
      "environment": "preview",
      "android": {
        "buildType": "apk"
      }
    }
  }
}
```

因此一般情況不需要再次執行 `eas build:configure`，也不要重新連結成另一個 EAS 專案。

## 一、準備環境

需要安裝：

- Node.js 與 npm
- Git
- 一個有權限存取 `softjoywander/smart-pet-life` EAS 專案的 Expo 帳號

在 PowerShell 執行：

```powershell
cd D:\Smart-Pet-Life\mobile
npm.cmd ci
npx.cmd eas-cli@latest login
npx.cmd eas-cli@latest whoami
```

`whoami` 顯示的 Expo 帳號必須具有此 EAS 專案的建置權限。

## 二、設定 preview 環境變數

App 需要以下兩個公開的 Supabase 用戶端設定：

- `EXPO_PUBLIC_SUPABASE_URL`
- `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`

本機開發使用 `mobile/.env`；EAS 雲端建置則應將相同名稱的變數設定在 EAS 的 `preview` 環境。請勿將 `.env` 上傳 Git。

先查看 EAS 上已有的變數：

```powershell
npx.cmd eas-cli@latest env:list --environment preview
```

若缺少變數，使用自己的實際值設定：

```powershell
npx.cmd eas-cli@latest env:set --name EXPO_PUBLIC_SUPABASE_URL --value "https://YOUR_PROJECT_REF.supabase.co" --environment preview --visibility plaintext
npx.cmd eas-cli@latest env:set --name EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY --value "YOUR_PUBLISHABLE_KEY" --environment preview --visibility plaintext
```

`EXPO_PUBLIC_` 變數會被編譯進 App，用戶端可以讀取，因此只能放 Supabase Project URL 與 Publishable Key。絕對不能放 Secret Key、`service_role` 或資料庫密碼。

## 三、建置前檢查

```powershell
cd D:\Smart-Pet-Life\mobile
npm.cmd run typecheck
npx.cmd expo-doctor
```

如果 `expo-doctor` 只提示套件有建議更新，先確認是否與目前 Expo SDK 相容，不要在產生 APK 前臨時大版本升級。

同時確認：

- `mobile/app.json` 的 Android Package 仍為 `life.smartpet.app`。
- `mobile/eas.json` 的 `preview.android.buildType` 仍為 `apk`。
- `.env`、金鑰、簽章檔、建置記錄與測試帳號密碼都沒有被加入 Git。
- `expo-sqlite` 與 `@react-native-community/netinfo` 版本仍符合目前 Expo SDK；它們負責離線記錄與連線恢復偵測。

## 四、產生 APK

執行：

```powershell
cd D:\Smart-Pet-Life\mobile
npx.cmd eas-cli@latest build --platform android --profile preview
```

第一次建置時，EAS 可能詢問 Android 簽章金鑰。若專案沒有既有金鑰，可讓 EAS 產生並代管；若已經有正式簽章金鑰，必須沿用同一把，否則之後無法直接覆蓋安裝或更新同一個 Package 的正式版本。

EAS 會上傳程式碼、排隊建置並在完成後提供下載網址。也可以稍後查看建置列表：

```powershell
npx.cmd eas-cli@latest build:list --platform android
```

## 五、安裝 APK

### 直接安裝到手機

1. 在 Android 手機開啟 EAS 提供的 APK 下載網址。
2. 下載 APK。
3. 若系統詢問，僅對目前使用的瀏覽器或檔案管理器允許「安裝未知應用程式」。
4. 安裝並開啟 Smart Pet Life。
5. 完成測試後，可把「安裝未知應用程式」權限關閉。

### 使用 ADB 安裝

先開啟手機的開發人員選項與 USB 偵錯，再執行：

```powershell
adb devices
adb install -r "C:\path\to\smart-pet-life.apk"
```

`-r` 代表保留 App 資料並覆蓋安裝。只有在新 APK 使用相同 Package 與簽章金鑰時才能正常更新。

## 六、常見問題

### App 可以安裝，但登入後無法載入資料

確認 EAS `preview` 環境已設定正確的 Supabase URL 與 Publishable Key，修改後必須重新建置 APK。

### 手機顯示「應用程式未安裝」

常見原因：

- 手機已安裝相同 Package、但簽章金鑰不同的版本。
- APK 下載不完整。
- 裝置空間不足。

如果是簽章不同，先確認舊 App 是否有需要保留的本機資料，再自行卸載舊版。卸載會刪除該 App 的本機資料。

若裝置仍有尚未同步的生活記錄，卸載或「清除資料」也會永久刪除這些本機記錄。建議先在生活紀錄頁確認顯示「所有可離線生活記錄均已同步」。

### 建置失敗

1. 開啟 EAS 回傳的 Build details 網址查看第一個實際錯誤。
2. 重新執行 `npm.cmd run typecheck` 與 `npx.cmd expo-doctor`。
3. 確認 EAS `preview` 環境變數存在。
4. 若判斷為快取問題，再嘗試：

```powershell
npx.cmd eas-cli@latest build --platform android --profile preview --clear-cache
```

不要用重複清快取掩蓋真正的 TypeScript、套件或原生設定錯誤。

### 可以完全在 Windows 本機產生嗎？

EAS 的 `--local` Android 建置正式支援 macOS 與 Linux；Windows 可嘗試 WSL，但 Expo 官方目前不正式測試或支援 Windows 本機 EAS Build，且需要自行安裝 Android SDK／NDK 等工具。因此本專案在 Windows 上優先使用 EAS 雲端建置。

在已準備完成的 Linux 或 WSL 環境中，可使用：

```bash
npx eas-cli@latest build --platform android --profile preview --local
```

本機建置時，必須自行提供建置所需環境變數與 Android 工具鏈。

## 七、APK 與 Google Play 的差異

| 用途 | 格式 | 建議設定 |
| --- | --- | --- |
| 手機直接安裝、內部測試 | APK | `preview`、`android.buildType: apk` |
| Google Play 上架 | AAB | production profile，預設輸出 AAB |

目前專案只明確設定了 preview APK。要建立正式商店版本前，應另外確認 production profile、版本號、隱私揭露、定位權限、正式簽章與 Google Play 政策，不要直接把 preview APK 當作上架檔案。

## 官方參考

- [Expo：建立可安裝的 Android APK](https://docs.expo.dev/build-reference/apk/)
- [Expo：第一次設定 EAS Build](https://docs.expo.dev/build/setup/)
- [Expo：EAS 環境變數](https://docs.expo.dev/eas/environment-variables/)
- [Expo：本機 EAS Build 與 Windows 限制](https://docs.expo.dev/build-reference/local-builds/)
