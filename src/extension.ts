/**
 * Activation, and nothing else.
 *
 * `activate` opens the log, hands control to the controller, and returns. The
 * controller's own constructor registers the views so both are on screen
 * immediately; the first walk is scheduled for after activation has returned,
 * because a directory of two hundred repositories must not decide how long the
 * editor takes to start.
 *
 * The history pane is registered by the controller, because it follows the list
 * and the controller is what knows the selection.
 */

import * as vscode from 'vscode';

import { LedgerController } from './controller.ts';
import { log, setLogSink } from './util/log.ts';

let controller: LedgerController | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('Multirepo Ledger');
  context.subscriptions.push(channel);
  setLogSink((_level, line) => channel.appendLine(line));

  context.subscriptions.push(
    vscode.commands.registerCommand('multirepoLedger.showOutput', () => channel.show(true)),
  );

  const instance = new LedgerController(context);
  controller = instance;
  context.subscriptions.push(instance);

  log.info(`Multirepo Ledger activated (${context.extension.packageJSON.version ?? 'dev'})`);

  setTimeout(() => {
    void instance.start().catch((error: unknown) => log.error('start failed', error));
  }, 0);
}

export function deactivate(): void {
  controller?.dispose();
  controller = undefined;
  setLogSink(undefined);
}
