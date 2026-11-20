// Lista de mandatos (F4 con la línea de mandatos vacía).
import { workWith, execFromLine } from './common.js';
import { COMMANDS } from '../commands/registry.js';

export async function selectCommand(ctx) {
  let message = null;
  await workWith(ctx, {
    fn: 'CMD-SLTCMD',
    title: 'Select Command',
    opts: ['1=Select'],
    optLen: 1,
    colHead: 'Opt  Command     Text',
    cmd: false,
    load: async () => [...COMMANDS.values()].sort((a, b) => a.name.localeCompare(b.name)),
    row: (c) => `${c.name.padEnd(10)}  ${c.title}`,
    key: (c) => c.name,
    act: async (sels) => {
      for (const s of sels) if (s.opt === '1') message = await execFromLine(ctx, s.item.name, true);
      return 'exit';
    },
    fkeys: ['F3=Exit   F5=Refresh   F12=Cancel'],
  });
  return message;
}
