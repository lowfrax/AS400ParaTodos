// Catálogo de mensajes (QCPFMSG): texto de primer nivel, causa y recuperación.
const M = {
  CPC1221: [0, 'Job &1/&2/&3 submitted to job queue &4 in library &5.'],
  CPC2101: [0, 'Library list changed.'],
  CPC2102: [0, 'Library &1 created.'],
  CPC2160: [0, 'Library &1 deleted.'],
  CPC2191: [0, 'Object &1 in &2 type &3 deleted.'],
  CPC2196: [0, 'Library &1 added to library list.'],
  CPC2197: [0, 'Library &1 removed from library list.'],
  CPC2198: [0, 'Current library changed to &1.'],
  CPC2206: [0, 'Ownership of object &1 in &2 type &3 changed.'],
  CPC2213: [0, 'Library &1 cleared.'],
  CPC2955: [0, '&1 records copied from member &2.'],
  CPC3101: [0, 'Member &1 removed from file &2 in &3.'],
  CPC3102: [0, 'Member &1 added to file &2 in &3.'],
  CPC3103: [0, 'Member &1 in file &2 in &3 cleared.'],
  CPC7301: [0, 'File &1 created in library &2.'],
  CPC2205: [0, 'User profile &1 created.'],
  CPC2191U: [0, 'Object &1 in &2 type *USRPRF deleted.'],
  CPC1001: [0, 'Data area &1 created in library &2.'],
  CPC1224: [0, 'Job &1/&2/&3 ended normally.'],
  CPF0001: [30, 'Error found on &1 command.', 'The system detected errors in the command.', 'See the previously listed messages, correct the errors, and then try the command again.'],
  CPD0030: [30, 'Command &1 in library &2 not found.', 'The command specified was not found in the libraries in the library list.', 'Correct the command name or the library name, or add the library to the library list.'],
  CPD0043: [30, 'Keyword &1 not valid for this command.', 'The keyword specified is not a parameter of the command.', 'Correct the keyword and try the command again.'],
  CPD0071: [30, 'Parameter &1 not valid for this command.'],
  CPD0072: [30, 'Parameter &1 required.', 'A value must be specified for required parameters.', 'Specify a value for the parameter and try the command again.'],
  CPD0074: [30, 'Value &1 not valid for parameter &2.'],
  CPD0078: [30, 'Value &1 for parameter &2 not a valid name.'],
  CPD0084: [30, 'Too many positional parameters specified for command &1.'],
  CPD0031: [30, 'Command &1 not allowed in this setting.'],
  CPD9861: [30, 'Function key not allowed.'],
  CPF0006: [30, 'Errors occurred in command.'],
  CPF1107: [30, 'Password not correct for user profile.', 'The password specified does not match the password of the user profile.', 'Enter the correct password. The user profile is disabled after QMAXSIGN invalid attempts.'],
  CPF1120: [30, 'User &1 does not exist.', 'The user profile is not on the system.', 'Enter the correct user name, or ask the security officer to create the profile (CRTUSRPRF).'],
  CPF1394: [30, 'User profile &1 cannot sign on.', 'The user profile has been disabled.', 'Ask the security officer to enable the profile (CHGUSRPRF STATUS(*ENABLED)).'],
  CPF1124: [0, 'Job &1/&2/&3 started on &4 at &5 in subsystem &6 in QSYS. Job entered system on &4 at &5.'],
  CPF1164: [0, 'Job &1/&2/&3 ended on &4 at &5; &6 seconds used; end code 0 .'],
  CPF1321: [40, 'Job &1 user &2 job number &3 not found.'],
  CPF1362: [30, 'Job &1/&2/&3 not active.'],
  CPF2103: [30, 'Library &1 already exists in library list.'],
  CPF2104: [30, 'Library &1 not removed from library list.'],
  CPF2110: [40, 'Library &1 not found.', 'The library specified was not found on the system.', 'Correct the library name and try the request again.'],
  CPF2111: [40, 'Library &1 already exists.', 'The library name specified already exists on the system.', 'Specify a different library name.'],
  CPF2105: [40, 'Object &1 in &2 type &3 not found.'],
  CPF2112: [40, 'Object &1 in &2 type &3 already exists.'],
  CPF2204: [40, 'User profile &1 not found.'],
  CPF2214: [40, 'Object &1 in &2 type &3 already exists.'],
  CPF2165: [40, 'Library &1 in use; not deleted.'],
  CPF3141: [40, 'Member &1 not found.'],
  CPF3204: [40, 'Cannot find object needed for file &1 in &2.'],
  CPF3213: [40, 'Member &1 not added to file &2 in &3.'],
  CPF4101: [40, 'File &1 in library &2 not found or inline data file missing.'],
  CPF5009: [40, 'Duplicate record key in member &1.'],
  CPF7302: [40, 'File &1 not created in library &2.'],
  CPF3220: [40, 'Cannot do operation on file &1 in &2: logical file &3 in &4 depends on it.'],
  CPF5D04: [40, 'Program or service program &1 in library &2 not created.'],
  CPD5D02: [30, 'Definition for symbol &1 not found.'],
  MCH4431: [40, '&1'],
  CPF5813: [30, 'File &1 in library &2 already exists.'],
  CPF9801: [40, 'Object &1 in library &2 not found.', 'The object was not found in the library.', 'Correct the object name or library name, or create the object.'],
  CPF9810: [40, 'Library &1 not found.'],
  CPF9811: [40, 'Program &1 in library &2 not found.', 'The program was not found in the library specified or in the library list.', 'Correct the program name, library, or the library list and try the request again.'],
  CPF9812: [40, 'File &1 in library &2 not found.'],
  CPF9815: [40, 'Member &1 file &2 in library &3 not found.'],
  CPF9897: [40, '&1'],
  CPF9898: [40, '&1'],
  CPF9899: [40, 'Error occurred during processing of command.'],
  CPF9999: [40, 'Function check. &1 unmonitored by &2 at statement &3, instruction X\'0000\'.'],
  CPA0701: [99, '&1 received by &2 at &3. (C D I R)'],
  CEE9901: [30, 'Application error. &1 unmonitored by &2 at statement &3, instruction X\'0000\'.'],
  CPF9871: [40, 'Error occurred while processing.'],
  RNQ0100: [99, 'Length or start position is out of range for the string operation (C G D F).'],
  RNQ0102: [99, 'Attempt to divide by zero (C G D F).'],
  RNQ0103: [99, 'The target for a numeric operation is too small to hold the result (C G D F).'],
  RNQ0105: [99, 'A character representation of a numeric value is in error (C G D F).'],
  RNQ0112: [99, 'Date, Time or Timestamp value is not valid (C G D F).'],
  RNQ0121: [99, 'An array index is out of range (C G D F).'],
  RNQ0202: [99, 'The call to &1 ended in error (C G D F).'],
  RNQ0211: [99, 'Error calling program or procedure (C G D F).'],
  RNQ1021: [99, 'Attempt to write a duplicate record to file &1 (C G D F).'],
  RNQ1211: [99, 'I/O operation was applied to closed file &1 (C G D F).'],
  RNQ1221: [99, 'Update or delete operation attempted without a prior input operation (C G D F).'],
  RNQ1299: [99, 'I/O error detected in file &1 (C G D F).'],
  RNQ9999: [99, 'Error message &1 appeared during processing (C G D F).'],
  SQL0204: [30, '&1 in &2 type *FILE not found.'],
  SQL7954: [0, '&1'],
  CPI2417: [0, 'Type reply, press Enter.'],
  CPF2817: [40, 'Copy command ended because of error.'],
  CPF0549: [40, 'Request ended. Request ended by user.'],
  CPC2604: [0, 'Password changed successfully.'],
  CPF2309: [30, 'No messages of the type requested in the queue.'],
  CPF0864: [0, 'End of file detected for file &1 in &2.'],
  CPD9801: [30, 'Option &1 not valid for this display.'],
  CPD6A01: [30, 'Option &1 not valid.'],
  CPF1096: [30, 'Command PWRDWNSYS not allowed in this clone. Use docker compose down.'],
  CPI2601: [0, 'No spooled files found.'],
  // Control de compromiso
  CPC8351: [0, 'Commitment control started with lock level &1.'],
  CPC8355: [0, 'Commitment control ended.'],
  CPC8301: [0, 'Commit operation completed.'],
  CPC8302: [0, 'Rollback operation completed.'],
  CPF8350: [40, 'Commitment definition not found.', 'Commitment control was not started for the job.', 'Start commitment control (STRCMTCTL) before running the request.'],
  CPF8351: [40, 'Commitment control already active with lock level &1.', 'STRCMTCTL was specified but commitment control is already active.', 'End commitment control (ENDCMTCTL) or continue with the active definition.'],
  CPF8356: [40, 'Commitment control ended with &1 local changes not committed.'],
  // Colas de datos
  CPC9801: [0, 'Object &1 type &2 created in library &3.'],
  CPF9502: [40, 'Error occurred while sending to or receiving from data queue &1 in &2: &3'],
  CPF9503: [40, 'Data queue &1 in &2 is full or the entry is too long (maximum &3).'],
  // TCP/IP
  TCP1A0F: [0, '&1 server starting.'],
  TCP1A10: [0, '&1 server ending.'],
  TCP1A11: [30, '&1 server is already active.'],
  TCP1A12: [30, '&1 server is not active.'],
  TCP1A13: [40, 'Server &1 not valid. Valid values: &2.'],
  TCP5090: [0, 'Email sent to &1 recipients.'],
  TCP5091: [40, 'Email not sent: &1'],
  // IFS
  CPFA0A9: [40, 'Object not found.  Object is &1.', 'The object specified in the path name was not found.', 'Correct the path name and try the request again.'],
  CPFA0A0: [40, 'Object already exists.  Object is &1.'],
  CPFA0AB: [40, 'Operation failed for object.  Object is &1. &2'],
  CPFA09C: [40, 'Not authorized to object.  Object is &1.'],
  CPCA051: [0, 'Directory created.'],
  CPCA052: [0, 'Directory removed.'],
  CPCA056: [0, 'Object deleted. Object is &1.'],
  CPCA058: [0, 'Object renamed.'],
  CPCA081: [0, 'Current directory changed.'],
  CPC2956: [0, '&1 records copied to stream file &2.'],
  CPC2957: [0, '&1 records copied from stream file &2.'],
  CPCA082: [0, 'Stream file copied to object.'],
  CPCA083: [0, 'Object copied to stream file.'],
  // Seguridad de servidores
  CPF22E2: [40, 'Password not correct for user profile &1.'],
  CPF22E3: [40, 'User profile &1 is disabled.'],
  CPF2204S: [40, 'User profile &1 not found.'],
};

export function msgText(id, ...args) {
  const def = M[id];
  let t = def ? def[1] : (args[0] || id);
  args.forEach((a, i) => { t = t.split(`&${i + 1}`).join(String(a ?? '').trim()); });
  return t.replace(/&\d/g, '').replace(/\s+\./g, '.').trim();
}
export function msgSev(id) { return M[id] ? M[id][0] : 30; }
export function msgHelp(id) {
  const d = M[id];
  return {
    cause: (d && d[2]) || 'No additional cause information is available for this message.',
    recovery: (d && d[3]) || 'See the previous messages in the job log (DSPJOBLOG) for more information.',
  };
}

/** Error de mensaje de escape (*ESCAPE) que interrumpe un mandato. */
export class CLError extends Error {
  constructor(id, ...args) {
    super(msgText(id, ...args));
    this.msgId = id;
    this.sev = msgSev(id);
    this.args = args;
  }
}

/** Mensaje de terminación/informativo */
export function msg(id, ...args) {
  return { id, text: msgText(id, ...args), sev: msgSev(id) };
}
