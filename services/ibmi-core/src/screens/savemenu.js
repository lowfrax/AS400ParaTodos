// Opciones 21, 22 y 23 de GO SAVE y GO RESTORE: piden los valores por omisión (dispositivo, comprobar archivos
// activos) y ejecutan la secuencia de mandatos que IBM i ejecuta para cada opción.
import { Panel } from '../panel.js';
import { SYS } from '../system.js';

const SEQS = {
  SAVE21: (d, chk) => [
    ...(chk ? [] : [`INZTAP DEV(${d}) CHECK(*NO)`]),
    `SAVSYS DEV(${d}) ENDOPT(*LEAVE)`,
    `SAVLIB LIB(*NONSYS) DEV(${d}) ENDOPT(*LEAVE)`,
    `SAV DEV('/QSYS.LIB/${d}.DEVD') OBJ(('/*') ('/QSYS.LIB' *OMIT) ('/QDLS' *OMIT)) ENDOPT(*REWIND)`,
  ],
  SAVE22: (d, chk) => [...(chk ? [] : [`INZTAP DEV(${d}) CHECK(*NO)`]), `SAVSYS DEV(${d}) ENDOPT(*LEAVE)`, `SAVLIB LIB(*IBM) DEV(${d}) ENDOPT(*REWIND)`],
  SAVE23: (d, chk) => [
    ...(chk ? [] : [`INZTAP DEV(${d}) CHECK(*NO)`]),
    `SAVSECDTA DEV(${d}) ENDOPT(*LEAVE)`,
    `SAVCFG DEV(${d}) ENDOPT(*LEAVE)`,
    `SAVLIB LIB(*ALLUSR) DEV(${d}) ENDOPT(*LEAVE)`,
    `SAV DEV('/QSYS.LIB/${d}.DEVD') OBJ(('/*') ('/QSYS.LIB' *OMIT) ('/QDLS' *OMIT)) ENDOPT(*REWIND)`,
  ],
  RESTORE22: (d) => [`RSTLIB SAVLIB(*IBM) DEV(${d}) ENDOPT(*REWIND)`],
  RESTORE23: (d) => [
    `RSTUSRPRF DEV(${d}) ENDOPT(*LEAVE)`,
    `RSTCFG OBJ(*ALL) DEV(${d}) OBJTYPE(*ALL) ENDOPT(*LEAVE)`,
    `RSTLIB SAVLIB(*ALLUSR) DEV(${d}) ENDOPT(*LEAVE)`,
    `RST DEV('/QSYS.LIB/${d}.DEVD') OBJ(('/*') ('/QSYS.LIB' *OMIT) ('/QDLS' *OMIT)) ENDOPT(*REWIND)`,
    'RSTAUT USRPRF(*ALL)',
  ],
};

export function saveOption(key, title) {
  return async (ctx) => {
    let dev = 'TAPVRT01';
    let check = 'Y';
    const p = new Panel({ fn: `MNU-${key}`, keys: ['F3', 'F12'] });
    p.title('Specify Command Defaults');
    p.text(2, 62, 'System:', 'g').text(2, 72, SYS.name, 'g');
    p.text(3, 2, `${title}`, 'w');
    p.text(5, 2, 'Type choices, press Enter.', 'b');
    p.label(7, 2, 'Devices', 36); p.input('DEV', 7, 40, 10, { value: dev }); p.text(7, 53, 'Name', 'b');
    if (key.startsWith('SAVE')) { p.label(9, 2, 'Check for active files', 36); p.input('CHK', 9, 40, 1, { value: check }); p.text(9, 53, 'Y=Yes, N=No', 'b'); }
    p.label(11, 2, 'Prompt for commands', 36); p.input('PRM', 11, 40, 1, { value: 'N' }); p.text(11, 53, 'Y=Yes, N=No', 'b');
    p.text(14, 2, 'The system is not ended to the restricted state: the save runs while the', 'b');
    p.text(15, 2, 'subsystems stay active (objects in use are saved as they are).', 'b');
    p.fkeys('F3=Exit   F12=Cancel');
    const r = await ctx.display(p);
    if (r.aid !== 'ENTER') return null;
    dev = String(r.fields.DEV || dev).trim().toUpperCase();
    check = String(r.fields.CHK || 'Y').trim().toUpperCase();
    const prompt = String(r.fields.PRM || 'N').trim().toUpperCase() === 'Y';
    const { runCommand } = await import('../commands/registry.js');
    let last = null;
    for (const c of SEQS[key](dev, check !== 'N')) {
      try {
        const out = await runCommand(ctx, prompt ? `?${c}` : c);
        last = out.filter((m) => m && m.text).pop() || last;
      } catch (e) {
        if (e.cancel) return { text: `${title} cancelled.`, sev: 30 };
        return { id: e.msgId, text: `${c.split(' ')[0]}: ${e.message}`, sev: 40 };
      }
    }
    return { text: `${title} completed${last ? `: ${last.text}` : '.'}` };
  };
}
