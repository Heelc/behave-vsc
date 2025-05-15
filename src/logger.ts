import * as vscode from 'vscode';
import { config } from './configuration';
import { getUrisOfWkspFoldersWithFeatures } from './common';

// 用于防止短时间内重复显示相同错误的缓存
interface ErrorCacheEntry {
  message: string;
  timestamp: number;
  uri?: vscode.Uri;
}

export class Logger {

  private channels: { [wkspUri: string]: vscode.OutputChannel } = {};
  public visible = false;
  // 错误缓存，用于防止重复弹窗
  private errorCache: ErrorCacheEntry[] = [];
  // 缓存过期时间（毫秒）
  private readonly ERROR_CACHE_EXPIRY = 5000; // 5秒
  // 诊断集合，用于在问题窗口中显示错误和警告
  private diagnosticCollection: vscode.DiagnosticCollection;

  constructor() {
    // 创建诊断集合
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection('behave-vsc');
  }

  syncChannelsToWorkspaceFolders() {

    const wkspUris = getUrisOfWkspFoldersWithFeatures(true);

    for (const wkspPath in this.channels) {
      this.channels[wkspPath].dispose();
      delete this.channels[wkspPath];
    }

    const wkspPaths = wkspUris.map(u => u.path);
    if (wkspPaths.length < 2) {
      this.channels[wkspUris[0].path] = vscode.window.createOutputChannel("Behave VSC");
      return;
    }

    wkspPaths.forEach(wkspPath => {
      const name = wkspPath.split("/").pop();
      if (!name)
        throw new Error("can't get workspace name from uri path");
      this.channels[wkspPath] = vscode.window.createOutputChannel(`Behave VSC: ${name}`);
    });
  }

  // 清理过期的错误缓存
  private cleanErrorCache() {
    const now = Date.now();
    this.errorCache = this.errorCache.filter(entry => (now - entry.timestamp) < this.ERROR_CACHE_EXPIRY);
  }

  // 检查是否是重复错误
  private isDuplicateError(message: string, uri?: vscode.Uri): boolean {
    this.cleanErrorCache();
    return this.errorCache.some(entry =>
      entry.message === message &&
      ((!uri && !entry.uri) || (uri && entry.uri && uri.toString() === entry.uri.toString()))
    );
  }

  // 添加错误到缓存
  private addToErrorCache(message: string, uri?: vscode.Uri) {
    this.errorCache.push({
      message,
      timestamp: Date.now(),
      uri
    });
  }

  dispose() {
    for (const wkspPath in this.channels) {
      this.channels[wkspPath].dispose();
    }
    // 释放诊断集合
    this.diagnosticCollection.dispose();
  }

  // 清除特定文件的诊断信息
  clearDiagnostics(uri?: vscode.Uri) {
    if (uri) {
      this.diagnosticCollection.delete(uri);
    } else {
      this.diagnosticCollection.clear();
    }
  }

  show = (wkspUri: vscode.Uri) => {
    this.channels[wkspUri.path].show();
  };

  clear = (wkspUri: vscode.Uri) => {
    this.channels[wkspUri.path].clear();
  };

  clearAllWksps = () => {
    for (const wkspPath in this.channels) {
      this.channels[wkspPath].clear();
    }
  };


  logInfoAllWksps = (text: string, run?: vscode.TestRun) => {
    diagLog(text);

    for (const wkspPath in this.channels) {
      this.channels[wkspPath].appendLine(text);
    }

    if (run)
      run.appendOutput(text + "\r\n");
  };


  logInfo = (text: string, wkspUri: vscode.Uri, run?: vscode.TestRun) => {
    diagLog(text);

    this.channels[wkspUri.path].appendLine(text);
    if (run)
      run.appendOutput(text + "\r\n");
  };

  // log info without a line feed (used for logging behave output)
  logInfoNoLF = (text: string, wkspUri: vscode.Uri, run?: vscode.TestRun) => {
    diagLog(text);

    this.channels[wkspUri.path].append(text);
    if (run)
      run.appendOutput(text);
  };

  // used by settings.ts 
  logSettingsWarning = (text: string, wkspUri: vscode.Uri, run?: vscode.TestRun) => {
    diagLog(text, wkspUri, DiagLogType.warn);

    // 添加到问题窗口
    this._addDiagnostic(text, wkspUri, vscode.DiagnosticSeverity.Warning);

    // 仍然保留在输出通道中，但不自动显示
    this.channels[wkspUri.path].appendLine(text);

    if (run)
      run.appendOutput(text + "\r\n");
  };


  showWarn = (text: string, wkspUri: vscode.Uri, run?: vscode.TestRun) => {
    this._show(text, wkspUri, run, DiagLogType.warn);
  }


  showError = (error: unknown, wkspUri?: vscode.Uri | undefined, run?: vscode.TestRun) => {

    let text: string;

    if (error instanceof Error) {
      text = error.message;
      if (error.stack && config && config.globalSettings && config.globalSettings.xRay)
        text += `\n${error.stack.split("\n").slice(1).join("\n")}`;
    }
    else {
      text = `${error}`;
    }

    this._show(text, wkspUri, run, DiagLogType.error);
  }

  // 添加诊断信息到问题窗口
  private _addDiagnostic(text: string, uri?: vscode.Uri, severity: vscode.DiagnosticSeverity = vscode.DiagnosticSeverity.Error) {
    if (!uri) return;

    // 检查是否是重复错误
    if (this.isDuplicateError(text, uri)) {
      return;
    }

    // 创建诊断信息
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(0, 0, 0, 0),
      text,
      severity
    );

    // 设置诊断信息的源
    diagnostic.source = 'Behave VSC';

    // 获取文件当前的诊断信息
    const currentDiagnostics = this.diagnosticCollection.get(uri) || [];

    // 检查是否已经存在相同的诊断信息
    if (!currentDiagnostics.some(d => d.message === text)) {
      // 创建新的诊断信息数组
      const newDiagnostics = [...currentDiagnostics, diagnostic];
      this.diagnosticCollection.set(uri, newDiagnostics);

      // 添加到缓存
      this.addToErrorCache(text, uri);
    }
  }

  private _show = (text: string, wkspUri: vscode.Uri | undefined, run: vscode.TestRun | undefined, logType: DiagLogType) => {

    diagLog(text, wkspUri, logType);

    // 将信息添加到输出通道
    if (wkspUri) {
      this.channels[wkspUri.path].appendLine(text);
    }
    else {
      for (const wkspPath in this.channels) {
        this.channels[wkspPath].appendLine(text);
      }
    }

    if (config.exampleProject && !text.includes("Canceled") && !text.includes("Cancelled")) {
      debugger; // eslint-disable-line no-debugger
    }

    let winText = text;
    if (wkspUri) {
      // note - don't use config.workspaceSettings here (possible inifinite loop)
      const wskpFolder = vscode.workspace.getWorkspaceFolder(wkspUri);
      if (wskpFolder) {
        const wkspName = wskpFolder?.name;
        winText = `${wkspName} workspace: ${text}`;
      }
    }

    if (winText.length > 512)
      winText = text.substring(0, 512) + "...";

    // 如果是错误或警告，添加到问题窗口
    if (logType === DiagLogType.error || logType === DiagLogType.warn) {
      const severity = logType === DiagLogType.error
        ? vscode.DiagnosticSeverity.Error
        : vscode.DiagnosticSeverity.Warning;

      if (wkspUri) {
        this._addDiagnostic(text, wkspUri, severity);
      }
    }

    // 如果禁用了弹窗通知，则只记录到问题窗口和输出通道，不显示弹窗
    if (config && config.globalSettings && config.globalSettings.disablePopupNotifications) {
      // 不需要额外操作，已经添加到问题窗口和输出通道
    } else {
      // 检查是否是重复错误（仅对警告和错误进行检查）
      if ((logType === DiagLogType.error || logType === DiagLogType.warn) && this.isDuplicateError(winText, wkspUri)) {
        // 是重复错误，不显示弹窗
      } else {
        // 不是重复错误或者是信息类型，正常显示弹窗
        switch (logType) {
          case DiagLogType.info:
            vscode.window.showInformationMessage(winText);
            break;
          case DiagLogType.warn:
            vscode.window.showWarningMessage(winText, "OK");
            // 添加到缓存
            this.addToErrorCache(winText, wkspUri);
            break;
          case DiagLogType.error:
            vscode.window.showErrorMessage(winText, "OK");
            // 添加到缓存
            this.addToErrorCache(winText, wkspUri);
            break;
        }
      }
    }

    //vscode.debug.activeDebugConsole.appendLine(text);
    if (run)
      run.appendOutput(text.replace("\n", "\r\n") + "\r\n");
  }
}

export enum DiagLogType {
  "info", "warn", "error"
}

export const diagLog = (message: string, wkspUri?: vscode.Uri, logType?: DiagLogType) => {
  if (config && !config.globalSettings.xRay && !config.integrationTestRun && !config.exampleProject)
    return;

  if (wkspUri)
    message = `${wkspUri}: ${message}`;

  message = `[Behave VSC] ${message}`;

  switch (logType) {
    case DiagLogType.error:
      console.error(message);
      break;
    case DiagLogType.warn:
      console.warn(message);
      break;
    default:
      console.log(message);
      break;
  }
}