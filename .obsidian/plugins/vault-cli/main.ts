import { App, Plugin, PluginSettingTab, Setting, Notice, Modal, TFile, MarkdownView, setIcon } from 'obsidian';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Constants
const PLUGIN_ID = 'vault-cli';
const CLI_TIMEOUT = 30000;
const DEBOUNCE_DELAY = 1000;

interface VaultCliSettings {
  autoSyncOnClose: boolean;
  showStatusBar: boolean;
  showTasks: boolean;
  showTasksRibbon: boolean;
  tasksExcludeFiles: string;
}

const DEFAULT_SETTINGS: VaultCliSettings = {
  autoSyncOnClose: true,
  showStatusBar: true,
  showTasks: true,
  showTasksRibbon: true,
  tasksExcludeFiles: 'CLAUDE.md'
};

interface Task {
  file: string;
  line: number;
  content: string;
  priority?: string;
  tags: string[];
  completed: boolean;
}

export default class VaultCliPlugin extends Plugin {
  settings: VaultCliSettings;
  private statusBarEl: HTMLElement | null = null;
  private tasksBarEl: HTMLElement | null = null;
  private statusTimeout: ReturnType<typeof setTimeout> | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.setupRibbonIcons();
    this.setupStatusBar();
    this.setupEventListeners();
    this.setupCommands();

    this.addSettingTab(new VaultCliSettingTab(this.app, this));
  }

  onunload(): void {
    if (this.statusTimeout) {
      clearTimeout(this.statusTimeout);
      this.statusTimeout = null;
    }
  }

  private setupRibbonIcons(): void {
    // Sync ribbon icon
    this.addRibbonIcon('github', 'Sync vault', () => this.runSync());

    // Tasks ribbon icon
    if (this.settings.showTasksRibbon) {
      this.addRibbonIcon('list-checks', 'Show tasks', () => this.showTasksModal());
    }
  }

  private setupStatusBar(): void {
    // Git status in status bar
    if (this.settings.showStatusBar) {
      this.statusBarEl = this.addStatusBarItem();
      this.statusBarEl.addClass('vault-cli-status');
      this.statusBarEl.addEventListener('click', () => this.showStatusModal());
      this.updateStatus();
    }

    // Tasks button in status bar
    if (this.settings.showTasks) {
      this.tasksBarEl = this.addStatusBarItem();
      this.tasksBarEl.addClass('vault-cli-tasks-bar');
      setIcon(this.tasksBarEl, 'list-checks');
      this.tasksBarEl.setAttribute('aria-label', 'Show tasks');
      this.tasksBarEl.addEventListener('click', () => this.showTasksModal());
    }
  }

  private setupEventListeners(): void {
    // Update status on file changes
    this.registerEvent(
      this.app.vault.on('modify', () => this.updateStatusDebounced())
    );
    this.registerEvent(
      this.app.vault.on('create', () => this.updateStatusDebounced())
    );
    this.registerEvent(
      this.app.vault.on('delete', () => this.updateStatusDebounced())
    );

    // Auto-sync on close
    if (this.settings.autoSyncOnClose) {
      this.registerEvent(
        this.app.workspace.on('quit', () => this.runSyncQuiet())
      );
    }
  }

  private setupCommands(): void {
    this.addCommand({
      id: 'sync',
      name: 'Sync vault',
      callback: () => this.runSync()
    });

    this.addCommand({
      id: 'status',
      name: 'Show git status',
      callback: () => this.showStatusModal()
    });

    this.addCommand({
      id: 'tasks',
      name: 'Show tasks',
      callback: () => this.showTasksModal()
    });

    this.addCommand({
      id: 'tasks-p1',
      name: 'Show P1 tasks',
      callback: () => this.showTasksModal('p1')
    });

    this.addCommand({
      id: 'tasks-next',
      name: 'Show next tasks',
      callback: () => this.showTasksModal('next')
    });

    this.addCommand({
      id: 'daily',
      name: 'Open daily note',
      callback: () => this.runCli('daily')
    });
  }

  private updateStatusDebounced(): void {
    if (this.statusTimeout) {
      clearTimeout(this.statusTimeout);
    }
    this.statusTimeout = setTimeout(() => this.updateStatus(), DEBOUNCE_DELAY);
  }

  private getVaultPath(): string {
    return (this.app.vault.adapter as any).basePath;
  }

  private async runCli(command: string): Promise<string> {
    const vaultPath = this.getVaultPath();
    try {
      const { stdout, stderr } = await execAsync(`./cli.sh ${command}`, {
        cwd: vaultPath,
        timeout: CLI_TIMEOUT
      });
      return stdout || stderr;
    } catch (error: any) {
      throw new Error(error.stderr || error.message);
    }
  }

  async runSync(): Promise<void> {
    new Notice('Syncing...');
    try {
      await this.runCli('sync');
      new Notice('Synced!');
      this.updateStatus();
    } catch (error: any) {
      new Notice(`Sync failed: ${error.message}`);
    }
  }

  private async runSyncQuiet(): Promise<void> {
    try {
      await this.runCli('sync');
    } catch (error) {
      console.error(`[${PLUGIN_ID}] Auto-sync failed:`, error);
    }
  }

  async showStatusModal(): Promise<void> {
    try {
      const result = await this.runCli('status');
      new StatusModal(this.app, this, result).open();
    } catch (error: any) {
      new Notice(`Status failed: ${error.message}`);
    }
  }

  async showTasksModal(filter?: string): Promise<void> {
    try {
      const tasks = await this.parseTasks(filter);
      new TasksModal(this.app, this, tasks, filter).open();
    } catch (error: any) {
      new Notice(`Tasks failed: ${error.message}`);
    }
  }

  private async parseTasks(filter?: string): Promise<Task[]> {
    const vaultPath = this.getVaultPath();
    const tasks: Task[] = [];
    const excludePatterns = this.getExcludePatterns();

    try {
      const { stdout } = await execAsync(
        `grep -rn "^\\s*- \\[[ x]\\]" --include="*.md" . 2>/dev/null || true`,
        { cwd: vaultPath, timeout: CLI_TIMEOUT }
      );

      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;

        const match = line.match(/^(.+\.md):(\d+):\s*- \[([ x])\]\s*(.+)$/);
        if (!match) continue;

        const [, file, lineNum, checkbox, content] = match;

        // Check if file should be excluded
        if (this.isFileExcluded(file, excludePatterns)) continue;

        const completed = checkbox === 'x';
        const tags = content.match(/#[\w\/]+/g) || [];

        const priority = this.detectPriority(tags);

        // Apply filter
        if (filter && priority !== filter) continue;

        // Skip completed tasks unless filtering
        if (completed && !filter) continue;

        tasks.push({
          file,
          line: parseInt(lineNum, 10),
          content,
          priority,
          tags,
          completed
        });
      }
    } catch (error) {
      console.error(`[${PLUGIN_ID}] Failed to parse tasks:`, error);
    }

    return tasks;
  }

  private getExcludePatterns(): string[] {
    return this.settings.tasksExcludeFiles
      .split(',')
      .map(p => p.trim())
      .filter(p => p.length > 0);
  }

  private isFileExcluded(file: string, patterns: string[]): boolean {
    const normalizedFile = file.replace('./', '');
    return patterns.some(pattern => {
      // Support simple wildcards: * matches any characters
      if (pattern.includes('*')) {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        return regex.test(normalizedFile);
      }
      // Exact match or ends with the pattern (for filenames)
      return normalizedFile === pattern || normalizedFile.endsWith('/' + pattern) || normalizedFile.endsWith(pattern);
    });
  }

  private detectPriority(tags: string[]): string | undefined {
    const priorityMap = ['p1', 'p2', 'p3', 'next', 'waiting', 'someday'];
    for (const priority of priorityMap) {
      if (tags.some(t => t.includes(priority))) {
        return priority;
      }
    }
    return undefined;
  }

  async toggleTask(task: Task): Promise<boolean> {
    const filePath = task.file.replace('./', '');
    const tfile = this.app.vault.getAbstractFileByPath(filePath);

    if (!(tfile instanceof TFile)) {
      new Notice('File not found');
      return task.completed;
    }

    try {
      const content = await this.app.vault.read(tfile);
      const lines = content.split('\n');
      const lineIndex = task.line - 1;

      if (lineIndex >= 0 && lineIndex < lines.length) {
        const searchPattern = task.completed ? '- [x]' : '- [ ]';
        const replacePattern = task.completed ? '- [ ]' : '- [x]';
        lines[lineIndex] = lines[lineIndex].replace(searchPattern, replacePattern);

        await this.app.vault.modify(tfile, lines.join('\n'));
        this.updateStatus();
        return !task.completed;
      }
    } catch (error: any) {
      new Notice(`Failed to toggle task: ${error.message}`);
    }
    return task.completed;
  }

  async openFileAtLine(file: string, line: number): Promise<void> {
    const filePath = file.replace('./', '');
    const tfile = this.app.vault.getAbstractFileByPath(filePath);

    if (!(tfile instanceof TFile)) {
      new Notice('File not found');
      return;
    }

    const leaf = this.app.workspace.getLeaf();
    await leaf.openFile(tfile);

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view) {
      const editor = view.editor;
      const pos = { line: line - 1, ch: 0 };
      editor.setCursor(pos);
      editor.scrollIntoView({ from: pos, to: pos }, true);
    }
  }

  private async updateStatus(): Promise<void> {
    if (!this.statusBarEl) return;

    try {
      const result = await this.runCli('status');
      const lines = result.split('\n');
      const changesLine = lines.find(l => l.includes('Uncommitted'));
      const changes = changesLine?.match(/(\d+)/)?.[1] || '0';

      if (changes === '0') {
        this.statusBarEl.setText('✓');
        this.statusBarEl.setAttribute('aria-label', 'No uncommitted changes');
      } else {
        this.statusBarEl.setText(`${changes} changes`);
        this.statusBarEl.setAttribute('aria-label', `${changes} uncommitted changes`);
      }
    } catch {
      this.statusBarEl.setText('git: error');
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

class StatusModal extends Modal {
  private plugin: VaultCliPlugin;
  private statusOutput: string;

  constructor(app: App, plugin: VaultCliPlugin, statusOutput: string) {
    super(app);
    this.plugin = plugin;
    this.statusOutput = statusOutput;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('vault-cli-status-modal');
    contentEl.createEl('h2', { text: 'Git Status' });

    const lines = this.statusOutput.split('\n');
    const branch = lines.find(l => l.startsWith('Branch:'))?.replace('Branch: ', '') || 'unknown';
    const changesLine = lines.find(l => l.includes('Uncommitted'));
    const changesCount = changesLine?.match(/(\d+)/)?.[1] || '0';
    const isClean = lines.some(l => l.includes('Working tree clean'));

    this.renderStatusInfo(contentEl, branch, changesCount, isClean);

    if (!isClean) {
      this.renderChangedFiles(contentEl, lines);
    }

    this.renderSyncButton(contentEl);
  }

  private renderStatusInfo(container: HTMLElement, branch: string, changesCount: string, isClean: boolean): void {
    const infoEl = container.createEl('div', { cls: 'vault-cli-status-info' });

    const branchEl = infoEl.createEl('div', { cls: 'vault-cli-status-row' });
    branchEl.createEl('span', { text: 'Branch', cls: 'vault-cli-status-label' });
    branchEl.createEl('span', { text: branch, cls: 'vault-cli-status-value' });

    const statusEl = infoEl.createEl('div', { cls: 'vault-cli-status-row' });
    statusEl.createEl('span', { text: 'Status', cls: 'vault-cli-status-label' });

    if (isClean) {
      statusEl.createEl('span', { text: '✓ Clean', cls: 'vault-cli-status-value vault-cli-status-clean' });
    } else {
      statusEl.createEl('span', { text: `${changesCount} uncommitted`, cls: 'vault-cli-status-value vault-cli-status-dirty' });
    }
  }

  private renderChangedFiles(container: HTMLElement, lines: string[]): void {
    const filesEl = container.createEl('div', { cls: 'vault-cli-status-files' });
    filesEl.createEl('div', { text: 'Changed files', cls: 'vault-cli-status-files-header' });

    const fileList = filesEl.createEl('ul', { cls: 'vault-cli-status-file-list' });

    for (const line of lines) {
      const fileMatch = line.match(/^\s*([MADR?]+)\s+(.+)$/);
      if (!fileMatch) continue;

      const [, status, file] = fileMatch;
      const itemEl = fileList.createEl('li', { cls: 'vault-cli-status-file-item' });

      const { text: statusText, className: statusClass } = this.getStatusDisplay(status);
      itemEl.createEl('span', { text: statusText, cls: `vault-cli-file-status ${statusClass}` });

      const isDeleted = status === 'D';
      const fileNameEl = itemEl.createEl('span', {
        text: file,
        cls: isDeleted ? 'vault-cli-file-name' : 'vault-cli-file-name vault-cli-clickable'
      });

      if (!isDeleted) {
        fileNameEl.addEventListener('click', () => {
          this.plugin.openFileAtLine(file, 1);
          this.close();
        });
      }
    }
  }

  private getStatusDisplay(status: string): { text: string; className: string } {
    switch (status) {
      case 'M': return { text: 'modified', className: 'vault-cli-file-modified' };
      case 'A':
      case '??': return { text: 'new', className: 'vault-cli-file-new' };
      case 'D': return { text: 'deleted', className: 'vault-cli-file-deleted' };
      case 'R': return { text: 'renamed', className: 'vault-cli-file-renamed' };
      default: return { text: status, className: '' };
    }
  }

  private renderSyncButton(container: HTMLElement): void {
    const buttonContainer = container.createEl('div', { cls: 'vault-cli-status-buttons' });
    const syncButton = buttonContainer.createEl('button', {
      text: 'Sync Now',
      cls: 'vault-cli-sync-button'
    });

    syncButton.addEventListener('click', async () => {
      syncButton.disabled = true;
      syncButton.setText('Syncing...');
      await this.plugin.runSync();
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class TasksModal extends Modal {
  private plugin: VaultCliPlugin;
  private tasks: Task[];
  private filter?: string;

  constructor(app: App, plugin: VaultCliPlugin, tasks: Task[], filter?: string) {
    super(app);
    this.plugin = plugin;
    this.tasks = tasks;
    this.filter = filter;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('vault-cli-tasks-modal');

    const title = this.filter ? `Tasks (${this.filter})` : 'Tasks';
    contentEl.createEl('h2', { text: title });

    if (this.tasks.length === 0) {
      contentEl.createEl('p', { text: 'No tasks found.', cls: 'vault-cli-no-tasks' });
      return;
    }

    const tasksByFile = this.groupTasksByFile();
    this.renderTaskGroups(contentEl, tasksByFile);
    this.renderFooter(contentEl);
  }

  private groupTasksByFile(): Map<string, Task[]> {
    const byFile = new Map<string, Task[]>();
    for (const task of this.tasks) {
      const existing = byFile.get(task.file) || [];
      existing.push(task);
      byFile.set(task.file, existing);
    }
    return byFile;
  }

  private renderTaskGroups(container: HTMLElement, tasksByFile: Map<string, Task[]>): void {
    for (const [file, fileTasks] of tasksByFile) {
      const fileEl = container.createEl('div', { cls: 'vault-cli-file-group' });

      const fileHeader = fileEl.createEl('div', {
        text: file.replace('./', '').replace('.md', ''),
        cls: 'vault-cli-file-header vault-cli-clickable'
      });
      fileHeader.addEventListener('click', () => {
        this.plugin.openFileAtLine(file, 1);
        this.close();
      });

      const listEl = fileEl.createEl('ul', { cls: 'vault-cli-task-list' });

      for (const task of fileTasks) {
        this.renderTask(listEl, task);
      }
    }
  }

  private renderTask(container: HTMLElement, task: Task): void {
    const itemEl = container.createEl('li', { cls: 'vault-cli-task-item' });
    if (task.completed) itemEl.addClass('vault-cli-task-completed');

    const checkbox = itemEl.createEl('input', { type: 'checkbox' });
    checkbox.checked = task.completed;
    checkbox.addEventListener('change', async () => {
      const newState = await this.plugin.toggleTask(task);
      task.completed = newState;
      itemEl.toggleClass('vault-cli-task-completed', newState);
    });

    const textContent = task.content.replace(/#[\w\/]+/g, '').trim();
    const textEl = itemEl.createEl('span', {
      text: textContent,
      cls: 'vault-cli-task-text vault-cli-clickable'
    });
    textEl.addEventListener('click', () => {
      this.plugin.openFileAtLine(task.file, task.line);
      this.close();
    });

    for (const tag of task.tags) {
      const tagEl = itemEl.createEl('span', { text: tag, cls: 'vault-cli-tag' });
      if (tag.includes('p1')) tagEl.addClass('vault-cli-tag-p1');
      else if (tag.includes('p2')) tagEl.addClass('vault-cli-tag-p2');
      else if (tag.includes('next')) tagEl.addClass('vault-cli-tag-next');
    }
  }

  private renderFooter(container: HTMLElement): void {
    container.createEl('div', {
      text: `${this.tasks.length} task${this.tasks.length === 1 ? '' : 's'}`,
      cls: 'vault-cli-task-count'
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class VaultCliSettingTab extends PluginSettingTab {
  plugin: VaultCliPlugin;

  constructor(app: App, plugin: VaultCliPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h3', { text: 'Sync' });

    new Setting(containerEl)
      .setName('Auto-sync on close')
      .setDesc('Automatically sync when closing Obsidian')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoSyncOnClose)
        .onChange(async (value) => {
          this.plugin.settings.autoSyncOnClose = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Show status bar')
      .setDesc('Show git changes count in the status bar')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showStatusBar)
        .onChange(async (value) => {
          this.plugin.settings.showStatusBar = value;
          await this.plugin.saveSettings();
          new Notice('Restart Obsidian to apply changes');
        }));

    containerEl.createEl('h3', { text: 'Tasks' });

    new Setting(containerEl)
      .setName('Show tasks in status bar')
      .setDesc('Show tasks button in the status bar')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showTasks)
        .onChange(async (value) => {
          this.plugin.settings.showTasks = value;
          await this.plugin.saveSettings();
          new Notice('Restart Obsidian to apply changes');
        }));

    new Setting(containerEl)
      .setName('Show tasks in ribbon')
      .setDesc('Show tasks button in the left ribbon')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showTasksRibbon)
        .onChange(async (value) => {
          this.plugin.settings.showTasksRibbon = value;
          await this.plugin.saveSettings();
          new Notice('Restart Obsidian to apply changes');
        }));

    new Setting(containerEl)
      .setName('Exclude files from tasks')
      .setDesc('Comma-separated list of files to exclude (supports * wildcards)')
      .addText(text => text
        .setPlaceholder('CLAUDE.md, Templates/*')
        .setValue(this.plugin.settings.tasksExcludeFiles)
        .onChange(async (value) => {
          this.plugin.settings.tasksExcludeFiles = value;
          await this.plugin.saveSettings();
        }));
  }
}
