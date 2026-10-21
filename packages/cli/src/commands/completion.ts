import { Command } from 'commander';

export type SupportedShell = 'bash' | 'zsh' | 'fish';

export function generateBashCompletion(cliName: string = 'stellar-alerts-cli'): string {
  return `#!/usr/bin/env bash
_\${cliName//-/_}_completions() {
  local cur prev words cword
  if type _init_completion >/dev/null 2>&1; then
    _init_completion || return
  else
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    words=("\${COMP_WORDS[@]}")
    cword=\$COMP_CWORD
  fi
  local root_commands="wallet stream profile health completion"
  local global_opts="--api-url -u --profile --help -h --version -V"
  case "\${prev}" in
    wallet) COMPREPLY=( $(compgen -W "list add remove update" -- "\${cur}") ); return 0 ;;
    stream) COMPREPLY=( $(compgen -W "start stop status events" -- "\${cur}") ); return 0 ;;
    profile) COMPREPLY=( $(compgen -W "list create use show delete" -- "\${cur}") ); return 0 ;;
    completion) COMPREPLY=( $(compgen -W "bash zsh fish" -- "\${cur}") ); return 0 ;;
  esac
  if [[ "\${cur}" == -* ]]; then
    COMPREPLY=( $(compgen -W "\${global_opts}" -- "\${cur}") )
    return 0
  fi
  COMPREPLY=( $(compgen -W "\${root_commands}" -- "\${cur}") )
  return 0
}
complete -F _\${cliName//-/_}_completions \${cliName}
`;
}

export function generateZshCompletion(cliName: string = 'stellar-alerts-cli'): string {
  return `#compdef \${cliName}
_\${cliName//-/_}() {
  local -a commands
  commands=(
    'wallet:Manage monitored wallets'
    'stream:Control and inspect event streams'
    'profile:Manage named configuration profiles'
    'health:Check API health status'
    'completion:Generate shell autocompletion script'
  )
  _describe -t commands 'command' commands
}
_\${cliName//-/_} "\$@"
`;
}

export function generateFishCompletion(cliName: string = 'stellar-alerts-cli'): string {
  return `# Fish completion for \${cliName}
complete -c \${cliName} -f
complete -c \${cliName} -n "__fish_use_subcommand" -a wallet -d 'Manage monitored wallets'
complete -c \${cliName} -n "__fish_use_subcommand" -a stream -d 'Control event streams'
complete -c \${cliName} -n "__fish_use_subcommand" -a profile -d 'Manage profiles'
complete -c \${cliName} -n "__fish_use_subcommand" -a completion -d 'Generate shell completion'
`;
}

export function registerCompletionCommands(program: Command): void {
  program
    .command('completion [shell]')
    .description('Generate shell auto-completion script for Bash, Zsh, or Fish')
    .action((shell?: string) => {
      const target = (shell || 'bash').toLowerCase() as SupportedShell;
      if (target === 'bash') process.stdout.write(generateBashCompletion(program.name()));
      else if (target === 'zsh') process.stdout.write(generateZshCompletion(program.name()));
      else if (target === 'fish') process.stdout.write(generateFishCompletion(program.name()));
      else {
        console.error(`Unsupported shell: ${shell}. Supported shells: bash, zsh, fish`);
        process.exit(1);
      }
    });
}
