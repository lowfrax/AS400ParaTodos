// Menús del sistema (GO MAIN, GO PROGRAM, …) con sus opciones reales.
import { showMenu } from './common.js';
import { CLError } from '../messages.js';
import { saveOption } from './savemenu.js';

export const MENUS = {
  MAIN: {
    title: 'IBM i Main Menu',
    options: [
      [1, 'User tasks', 'GO USERTASK'],
      [2, 'Office tasks', 'GO OFFICE'],
      [3, 'General system tasks', 'GO SYSTEM'],
      [4, 'Files, libraries, and folders', 'GO DATA'],
      [5, 'Programming', 'GO PROGRAM'],
      [6, 'Communications', 'GO CMN'],
      [7, 'Define or change the system', 'GO DEFINE'],
      [8, 'Problem handling', 'GO PROBLEM'],
      [9, 'Display a menu', '?GO'],
      [10, 'Information Assistant options', 'GO INFO'],
      [11, 'IBM i Access tasks', 'GO CAACCESS'],
    ],
    bottomOptions: [[90, 'Sign off', 'SIGNOFF']],
  },
  USERTASK: {
    title: 'User Tasks',
    options: [
      [1, 'Display or change your job', 'DSPJOBLOG'],
      [2, 'Display messages', 'DSPMSG'],
      [3, 'Send a message', '?SNDMSG'],
      [4, 'Submit a job', '?SBMJOB'],
      [5, 'Work with your spooled output files', 'WRKSPLF'],
      [6, 'Work with your batch jobs', 'WRKACTJOB SBS(QBATCH)'],
      [7, 'Display or change your library list', 'DSPLIBL'],
      [8, 'Change your password', 'CHGPWD'],
      [9, 'Change your user profile', '?CHGPRF'],
      [10, 'Display or change your object authority', null],
    ],
    bottomOptions: [[90, 'Sign off', 'SIGNOFF']],
  },
  OFFICE: { title: 'Office Tasks', options: [[1, 'Office security', null], [2, 'Work with directory', null], [90, 'Sign off', 'SIGNOFF']] },
  SYSTEM: {
    title: 'General System Tasks',
    options: [
      [1, 'System status', 'WRKSYSSTS'],
      [2, 'Device status tasks', null],
      [3, 'Jobs', 'WRKACTJOB'],
      [4, 'Messages', 'DSPMSG'],
      [5, 'Printing', 'WRKSPLF SELECT(*ALL)'],
      [6, 'Programming', 'GO PROGRAM'],
      [7, 'System control', 'WRKSYSVAL'],
      [8, 'Device configuration', 'WRKCFGSTS CFGTYPE(*DEV)'],
      [10, 'Communications', null],
      [11, 'Subsystems', 'WRKSBS'],
    ],
    bottomOptions: [[90, 'Sign off', 'SIGNOFF']],
  },
  DATA: {
    title: 'Files, Libraries, and Folders',
    options: [
      [1, 'Files', 'WRKOBJPDM LIB(*CURLIB) OBJTYPE(*FILE)'],
      [2, 'Libraries', 'WRKLIBPDM LIB(*ALL)'],
      [3, 'Folders', null],
      [4, 'Database', 'STRSQL'],
      [5, 'Objects', 'WRKOBJ'],
    ],
    bottomOptions: [[90, 'Sign off', 'SIGNOFF']],
  },
  PROGRAM: {
    title: 'Programming',
    options: [
      [1, 'Programmer menu', 'GO PROGRAM'],
      [2, 'Programming Development Manager (PDM)', 'STRPDM'],
      [3, 'Utilities', 'GO UTILITIES'],
      [4, 'Programming language debug', null],
      [5, 'Structured Query Language (SQL) pgm', 'STRSQL'],
      [6, 'Question and answer', null],
      [7, 'Copy screen image', null],
      [8, 'Cross System Product', null],
      [9, 'Work with Database Files', 'WRKOBJPDM LIB(*CURLIB) OBJTYPE(*FILE)'],
      [10, 'Work with Programs', 'WRKOBJPDM LIB(*CURLIB) OBJTYPE(*PGM)'],
    ],
    bottomOptions: [[50, 'System/36 environment', null], [70, 'Related commands', null], [90, 'Sign off', 'SIGNOFF']],
  },
  UTILITIES: {
    title: 'Utilities',
    options: [
      [1, 'Programming Development Manager (PDM)', 'STRPDM'],
      [2, 'Source entry utility (SEU)', '?STRSEU'],
      [3, 'Interactive SQL', 'STRSQL'],
      [4, 'Display physical file member', '?DSPPFM'],
      [5, 'Display file field description', '?DSPFFD'],
      [6, 'Screen design aid (SDA)', 'STRSDA'],
      [7, 'Report layout utility (RLU)', '?STRRLU'],
      [8, 'Query utilities', 'STRQRY'],
    ],
    bottomOptions: [[90, 'Sign off', 'SIGNOFF']],
  },
  CMN: { title: 'Communications', options: [[1, 'Communications status', null], [2, 'TCP/IP administration', null]], bottomOptions: [[90, 'Sign off', 'SIGNOFF']] },
  DEFINE: {
    title: 'Define or Change the System',
    options: [
      [1, 'System values', 'WRKSYSVAL'],
      [2, 'User profiles', 'WRKUSRPRF'],
      [3, 'Subsystems', 'WRKSBS'],
    ],
    bottomOptions: [[90, 'Sign off', 'SIGNOFF']],
  },
  PROBLEM: {
    title: 'Problem Handling',
    options: [[1, 'Work with problems', null], [2, 'Display job log', 'DSPJOBLOG'], [3, 'Display system operator messages', 'DSPMSG QSYSOPR']],
    bottomOptions: [[90, 'Sign off', 'SIGNOFF']],
  },
  SAVE: {
    title: 'Save',
    options: [
      [1, 'Files', '?SAVOBJ OBJTYPE(*FILE)'],
      [2, 'Libraries', '?SAVLIB'],
      [4, 'Programs', '?SAVOBJ OBJTYPE(*PGM)'],
      [5, 'Other objects', '?SAVOBJ'],
      [6, 'Changed objects only', '?SAVCHGOBJ'],
      [8, 'Security data', '?SAVSECDTA'],
      [10, 'Configuration', '?SAVCFG'],
      [11, 'Objects in directories', '?SAV'],
      [null],
      [21, 'Entire system', saveOption('SAVE21', 'Save entire system')],
      [22, 'System data only', saveOption('SAVE22', 'Save system data only')],
      [23, 'All user data', saveOption('SAVE23', 'Save all user data')],
      [40, 'All libraries other than the system library', '?SAVLIB LIB(*NONSYS)'],
      [42, 'All user libraries', '?SAVLIB LIB(*ALLUSR)'],
    ],
  },
  RESTORE: {
    title: 'Restore',
    options: [
      [1, 'Files', '?RSTOBJ OBJTYPE(*FILE)'],
      [2, 'Libraries', '?RSTLIB'],
      [4, 'Programs', '?RSTOBJ OBJTYPE(*PGM)'],
      [5, 'Other objects', '?RSTOBJ'],
      [8, 'Security data', '?RSTUSRPRF'],
      [9, 'Authorities', '?RSTAUT'],
      [10, 'Configuration', '?RSTCFG'],
      [11, 'Objects in directories', '?RST'],
      [null],
      [21, 'System and user data', null],
      [22, 'System data only', saveOption('RESTORE22', 'Restore system data only')],
      [23, 'All user data', saveOption('RESTORE23', 'Restore all user data')],
      [40, 'All libraries other than the system library', '?RSTLIB SAVLIB(*NONSYS)'],
      [42, 'All user libraries', '?RSTLIB SAVLIB(*ALLUSR)'],
    ],
  },
  INFO: { title: 'Information Assistant Options', options: [[1, 'Where to find information', null], [2, 'How to use help', null]], bottomOptions: [[90, 'Sign off', 'SIGNOFF']] },
  CAACCESS: { title: 'IBM i Access Tasks', options: [[1, 'Copy data to/from PC', null], [2, 'Work with IBM i Access', null]], bottomOptions: [[90, 'Sign off', 'SIGNOFF']] },
};

export async function goMenu(ctx, name) {
  const m = MENUS[name];
  if (!m) throw new CLError('CPF9801', name, '*LIBL');
  return showMenu(ctx, { id: name, ...m });
}
