import java.sql.*;
public class Jdbc {
  public static void run(int base) throws Exception {
    // jt400: el puerto de la base de datos se fuerza con el mapeo de servicios del objeto AS400 subyacente
    com.ibm.as400.access.AS400 sys = new com.ibm.as400.access.AS400("127.0.0.1", "DEMO", "DEMO");
    sys.setGuiAvailable(false);
    sys.setServicePort(com.ibm.as400.access.AS400.SIGNON, base + 6);
    sys.setServicePort(com.ibm.as400.access.AS400.DATABASE, base + 1);
    com.ibm.as400.access.AS400JDBCDriver d = new com.ibm.as400.access.AS400JDBCDriver();
    java.util.Properties pr = new java.util.Properties();
    pr.setProperty("naming", "system"); pr.setProperty("libraries", "DEMOLIB"); pr.setProperty("prompt", "false");
    try (Connection c = d.connect(sys, pr, "DEMOLIB")) {
      DatabaseMetaData md = c.getMetaData();
      System.out.println("JDBC " + md.getDatabaseProductName() + " " + md.getDatabaseProductVersion());
      try (Statement s = c.createStatement(); ResultSet rs = s.executeQuery("SELECT CUSTNO, NAME, BALANCE FROM CUSTOMER ORDER BY CUSTNO FETCH FIRST 3 ROWS ONLY")) {
        ResultSetMetaData m = rs.getMetaData();
        System.out.println("  cols=" + m.getColumnCount() + " " + m.getColumnName(2) + " " + m.getColumnTypeName(3));
        while (rs.next()) System.out.println("  " + rs.getInt(1) + " | " + rs.getString(2).trim() + " | " + rs.getBigDecimal(3));
      }
      try (PreparedStatement ps = c.prepareStatement("SELECT NAME FROM CUSTOMER WHERE CUSTNO = ?")) {
        ps.setInt(1, 12);
        try (ResultSet rs = ps.executeQuery()) { rs.next(); System.out.println("  prepared: " + rs.getString(1).trim()); }
      }
      try (Statement s = c.createStatement()) {
        s.executeUpdate("CREATE TABLE JTTEST.T1 (ID INTEGER NOT NULL PRIMARY KEY, TXT VARCHAR(20))");
        int n = s.executeUpdate("INSERT INTO JTTEST.T1 VALUES (1, 'uno'), (2, 'dos')");
        System.out.println("  insert=" + n);
      }
      c.setAutoCommit(false);
      try (Statement s = c.createStatement()) { s.executeUpdate("DELETE FROM JTTEST.T1"); }
      c.rollback();
      try (Statement s = c.createStatement(); ResultSet rs = s.executeQuery("SELECT COUNT(*) FROM JTTEST.T1")) { rs.next(); System.out.println("  tras rollback=" + rs.getInt(1)); }
      c.setAutoCommit(true);
      try (ResultSet rs = md.getTables(null, "DEMOLIB", "%", null)) { int n = 0; while (rs.next()) n++; System.out.println("  getTables(DEMOLIB)=" + n); }
    }
  }
}
