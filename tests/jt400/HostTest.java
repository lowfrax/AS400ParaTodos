import com.ibm.as400.access.*;
public class HostTest {
  public static void main(String[] a) throws Exception {
    int base = Integer.parseInt(System.getProperty("base", "18470"));
    AS400 sys = new AS400("127.0.0.1", "DEMO", "DEMO");
    sys.setGuiAvailable(false);
    sys.setServicePort(AS400.SIGNON, base + 6);
    sys.setServicePort(AS400.COMMAND, base + 5);
    sys.setServicePort(AS400.DATAQUEUE, base + 2);
    sys.setServicePort(AS400.DATABASE, base + 1);
    sys.setServicePort(AS400.CENTRAL, base);
    sys.validateSignon();
    System.out.println("signon OK, VRM=" + Integer.toHexString(sys.getVRM()));
    CommandCall cc = new CommandCall(sys);
    cc.run("DLTLIB LIB(JTTEST)");
    boolean ok = cc.run("CRTLIB LIB(JTTEST) TEXT('jt400')");
    System.out.println("CommandCall CRTLIB=" + ok);
    for (AS400Message m : cc.getMessageList()) System.out.println("  " + m.getID() + " " + m.getText());
    ok = cc.run("CHKOBJ OBJ(JTTEST/NADA) OBJTYPE(*PGM)");
    AS400Message[] ml = cc.getMessageList();
    System.out.println("CommandCall CHKOBJ(missing)=" + ok + " " + (ml.length > 0 ? ml[ml.length - 1].getID() : "-"));
    ProgramParameter[] p = new ProgramParameter[9];
    p[0] = new ProgramParameter(new AS400PackedDecimal(10, 0).toBytes(new java.math.BigDecimal("1001")));
    p[1] = new ProgramParameter(40); p[2] = new ProgramParameter(3); p[3] = new ProgramParameter(3);
    p[4] = new ProgramParameter(8); p[5] = new ProgramParameter(8); p[6] = new ProgramParameter(1); p[7] = new ProgramParameter(2); p[8] = new ProgramParameter(60);
    ProgramCall pc = new ProgramCall(sys, "/QSYS.LIB/BANCO.LIB/BNKSALDO.PGM", p);
    System.out.println("ProgramCall=" + pc.run());
    AS400Text t40 = new AS400Text(40, sys), t3 = new AS400Text(3, sys), t2 = new AS400Text(2, sys);
    AS400PackedDecimal p152 = new AS400PackedDecimal(15, 2);
    System.out.println("  nombre=" + ((String) t40.toObject(p[1].getOutputData())).trim() + " moneda=" + t3.toObject(p[3].getOutputData()) + " saldo=" + p152.toObject(p[4].getOutputData()) + " rc=" + t2.toObject(p[7].getOutputData()));
    cc.run("CRTDTAQ DTAQ(JTTEST/JQ) MAXLEN(100)");
    DataQueue dq = new DataQueue(sys, "/QSYS.LIB/JTTEST.LIB/JQ.DTAQ");
    dq.write("hola desde jt400");
    DataQueueEntry e = dq.read(2);
    System.out.println("DataQueue read=" + (e == null ? null : e.getString()) + " maxlen=" + dq.getMaxEntryLength());
    System.out.println("DataQueue empty read=" + dq.read(0));
    if (System.getProperty("jdbc") != null) Jdbc.run(base);
    cc.run("DLTLIB LIB(JTTEST)");
    sys.disconnectAllServices();
    System.out.println("FIN");
  }
}
