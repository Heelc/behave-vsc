import * as vscode from 'vscode';
import * as fs from 'fs';
import {
  findHighestTargetParentDirectorySync, findSubdirectorySync, getUrisOfWkspFoldersWithFeatures,
  getWorkspaceFolder, uriId, WkspError
} from './common';
import { config } from './configuration';
import { Logger } from './logger';


export class WindowSettings {
  // class for package.json "window" settings 
  // these apply to the whole vscode instance, but may be set in settings.json or *.code-workspace 
  // (in a multi-root workspace they will be read from *.code-workspace, and greyed-out and disabled in settings.json)
  public readonly multiRootRunWorkspacesInParallel: boolean;
  public readonly xRay: boolean;
  public readonly disablePopupNotifications: boolean;

  constructor(winConfig: vscode.WorkspaceConfiguration) {

    // note: undefined should never happen (or packages.json is wrong) as get will return a default value for packages.json settings
    const multiRootRunWorkspacesInParallelCfg: boolean | undefined = winConfig.get("multiRootRunWorkspacesInParallel");
    if (multiRootRunWorkspacesInParallelCfg === undefined)
      throw "multiRootRunWorkspacesInParallel is undefined";
    const xRayCfg: boolean | undefined = winConfig.get("xRay");
    if (xRayCfg === undefined)
      throw "xRay is undefined";
    const disablePopupNotificationsCfg: boolean | undefined = winConfig.get("disablePopupNotifications");
    if (disablePopupNotificationsCfg === undefined)
      throw "disablePopupNotifications is undefined";

    this.multiRootRunWorkspacesInParallel = multiRootRunWorkspacesInParallelCfg;
    this.xRay = xRayCfg;
    this.disablePopupNotifications = disablePopupNotificationsCfg;
  }
}


export class WorkspaceSettings {
  // class for package.json "resource" settings in settings.json

  // from config
  public readonly uri: vscode.Uri;
  public readonly name: string;
  public readonly id: string;
  public readonly workspaceRelativeFeaturesPath: string;
  public readonly featuresUri: vscode.Uri;
  public readonly stepsSearchUri: vscode.Uri;
  public readonly justMyCode: boolean;
  public readonly runParallel: boolean;
  public readonly envVarOverrides: { [name: string]: string } = {};
  public readonly fullFeaturesPath: string;
  public readonly junitTempPath: string;

  // additional features paths for multi-features support
  public readonly additionalFeaturesPaths: {
    workspaceRelativePath: string;
    uri: vscode.Uri;
    stepsSearchUri: vscode.Uri;
  }[] = [];

  private _warnings: string[] = [];
  private _fatalErrors: string[] = [];


  constructor(wkspUri: vscode.Uri, wkspConfig: vscode.WorkspaceConfiguration, winSettings: WindowSettings, logger: Logger) {

    this.uri = wkspUri;
    this.name = wkspUri.path.split('/').pop() || wkspUri.path;
    this.id = uriId(wkspUri);

    // note: undefined should never happen (or packages.json is wrong) as get will return a default value for packages.json settings
    const justMyCodeCfg: boolean | undefined = wkspConfig.get("justMyCode");
    if (justMyCodeCfg === undefined)
      throw "justMyCode is undefined";
    const runParallelCfg: boolean | undefined = wkspConfig.get("runParallel");
    if (runParallelCfg === undefined)
      throw "runParallel is undefined";
    const featuresPathCfg: string | undefined = wkspConfig.get("featuresPath");
    if (featuresPathCfg === undefined)
      throw "featuresPath is undefined";
    const envVarOverridesCfg: { [name: string]: string } | undefined = wkspConfig.get("envVarOverrides");

    this.justMyCode = justMyCodeCfg;
    this.runParallel = runParallelCfg;
    this.workspaceRelativeFeaturesPath = featuresPathCfg;
    this.junitTempPath = config.extensionTempFilesUri.fsPath;


    // vscode will not substitute a default if an empty string is specified in settings.json
    if (!this.workspaceRelativeFeaturesPath)
      this.workspaceRelativeFeaturesPath = "features";
    this.featuresUri = vscode.Uri.joinPath(wkspUri, this.workspaceRelativeFeaturesPath);
    if (this.workspaceRelativeFeaturesPath === ".")
      this._fatalErrors.push(`"." is not a valid "behave-vsc.featuresPath" value. The features folder must be a subfolder.`);
    if (!fs.existsSync(this.featuresUri.fsPath)) {
      // note - this error should never happen or some logic/hooks are wrong 
      // (or the user has actually deleted/moved the features path since loading)
      // because the existence of the path should always be checked by getUrisOfWkspFoldersWithFeatures(true)
      // before we get here (i.e. called elsewhere when workspace folders/settings are changed etc.)    
      this._fatalErrors.push(`features path ${this.featuresUri.fsPath} not found.`);
    }

    // 检查behave.ini文件中是否有多个features路径
    this.checkAdditionalFeaturesPaths(wkspUri, logger);

    // default to watching features folder for (possibly multiple) "steps" 
    // subfolders (e.g. like example project B/features folder)
    this.stepsSearchUri = vscode.Uri.joinPath(this.featuresUri);
    if (!findSubdirectorySync(this.stepsSearchUri.fsPath, "steps")) {
      // if not found, get the highest-level "steps" folder above the features folder inside the workspace
      const stepsSearchFsPath = findHighestTargetParentDirectorySync(this.featuresUri.fsPath, this.uri.fsPath, "steps");
      if (stepsSearchFsPath)
        this.stepsSearchUri = vscode.Uri.file(stepsSearchFsPath);
      else
        logger.showWarn(`No "steps" folder found.`, this.uri);
    }

    // 为每个额外的features路径设置steps搜索路径
    for (const additionalPath of this.additionalFeaturesPaths) {
      if (!findSubdirectorySync(additionalPath.uri.fsPath, "steps")) {
        // 如果在features目录中没有找到steps目录，尝试在更高级目录中查找
        const stepsSearchFsPath = findHighestTargetParentDirectorySync(additionalPath.uri.fsPath, this.uri.fsPath, "steps");
        if (stepsSearchFsPath) {
          additionalPath.stepsSearchUri = vscode.Uri.file(stepsSearchFsPath);
        } else {
          // 如果没有找到steps目录，使用主features目录的steps搜索路径
          additionalPath.stepsSearchUri = this.stepsSearchUri;
        }
      } else {
        // 在features目录中找到了steps目录
        additionalPath.stepsSearchUri = additionalPath.uri;
      }
    }

    this.fullFeaturesPath = this.featuresUri.fsPath;

    if (envVarOverridesCfg) {
      const err = `Invalid envVarOverrides setting ${JSON.stringify(envVarOverridesCfg)} ignored.`;
      try {
        if (typeof envVarOverridesCfg !== "object") {
          this._warnings.push(err);
        }
        else {
          for (const name in envVarOverridesCfg) {
            // just check for "=" typo
            if (name.includes("=")) {
              this._warnings.push(`${err} ${name} must not contain =`);
              break;
            }
            const value = envVarOverridesCfg[name];
            if (value) {
              if (typeof value !== "string") {
                this._warnings.push(`${err} ${value} is not a string`);
                break;
              }
              this.envVarOverrides[name] = value;
            }
          }
        }
      }
      catch {
        this._warnings.push(err);
      }
    }


    this.logSettings(logger, winSettings);
  }

  // 检查behave.ini文件中是否有多个features路径
  private checkAdditionalFeaturesPaths(wkspUri: vscode.Uri, logger: Logger) {
    try {
      const behaveIniPath = vscode.Uri.joinPath(wkspUri, "behave.ini").fsPath;
      if (fs.existsSync(behaveIniPath)) {
        const content = fs.readFileSync(behaveIniPath, 'utf8');
        const pathsMatch = content.match(/paths\s*=\s*([\s\S]*?)(?:\n\[|$)/);

        if (pathsMatch && pathsMatch[1]) {
          const paths = pathsMatch[1].split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#'));

          // 第一个路径应该与workspaceRelativeFeaturesPath匹配
          // 其他路径添加到additionalFeaturesPaths
          for (let i = 0; i < paths.length; i++) {
            const path = paths[i];
            // 跳过与主features路径相同的路径
            if (path === this.workspaceRelativeFeaturesPath) {
              continue;
            }

            const featureUri = vscode.Uri.joinPath(wkspUri, path);
            if (fs.existsSync(featureUri.fsPath)) {
              this.additionalFeaturesPaths.push({
                workspaceRelativePath: path,
                uri: featureUri,
                stepsSearchUri: featureUri // 默认值，将在构造函数中更新
              });
              logger.logInfo(`Found additional features path: ${path}`, this.uri);
            } else {
              logger.showWarn(`Additional features path ${path} specified in behave.ini not found.`, this.uri);
            }
          }
        }
      }
    } catch (error) {
      logger.showWarn(`Error parsing behave.ini: ${error}`, this.uri);
    }
  }

  logSettings(logger: Logger, winSettings: WindowSettings) {

    // build sorted output dict of window settings
    const winSettingsDict: { [key: string]: unknown } = {};
    for (const key of Object.getOwnPropertyNames(winSettings)) {
      if (key !== "constructor" && !key.startsWith("_"))
        winSettingsDict[key] = (winSettings as any)[key];
    }
    logger.logInfo(`instance settings:\n${JSON.stringify(winSettingsDict, Object.keys(winSettingsDict).sort(), 2)}`, this.uri);

    // build sorted output dict of workspace settings
    const wkspSettingsDict: { [key: string]: unknown } = {};
    for (const key of Object.getOwnPropertyNames(this)) {
      if (key !== "constructor" && !key.startsWith("_") &&
        key !== "uri" && key !== "name" && key !== "id" &&
        key !== "featuresUri" && key !== "stepsSearchUri" &&
        key !== "additionalFeaturesPaths") {
        wkspSettingsDict[key] = (this as any)[key];
      }
    }
    logger.logInfo(`${this.name} workspace settings:\n${JSON.stringify(wkspSettingsDict, Object.keys(wkspSettingsDict).sort(), 2)}`, this.uri);

    // 记录额外的features路径信息
    if (this.additionalFeaturesPaths.length > 0) {
      const additionalPathsInfo = this.additionalFeaturesPaths.map(p => ({
        workspaceRelativePath: p.workspaceRelativePath,
        fullPath: p.uri.fsPath
      }));
      logger.logInfo(`${this.name} additional features paths:\n${JSON.stringify(additionalPathsInfo, null, 2)}`, this.uri);
    }

    for (const warning of this._warnings) {
      logger.logSettingsWarning(warning, this.uri);
    }

    if (this._fatalErrors.length > 0) {
      throw new WkspError(`\nFATAL error due to invalid workspace setting in workspace "${this.name}". Extension cannot continue. ` +
        `${this._fatalErrors.join("\n")}\n` +
        `NOTE: fatal errors may require you to restart vscode after correcting the problem.) `, this.uri);
    }
  }
}


