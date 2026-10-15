package hello;

import java.awt.BorderLayout;
import java.awt.Font;
import javax.swing.BorderFactory;
import javax.swing.JButton;
import javax.swing.JFrame;
import javax.swing.JLabel;
import javax.swing.SwingConstants;
import javax.swing.SwingUtilities;

/** A small Swing app used to check the Java backend. Build with scripts/make-examples.mjs. */
public final class Main {
  private static int clicks = 0;

  public static void main(String[] args) {
    SwingUtilities.invokeLater(() -> {
      JFrame frame = new JFrame("Hello (Java Swing)");
      JLabel label = new JLabel("<html><center>Hello from webapp-anything!<br>This Swing app runs in your browser.</center></html>",
          SwingConstants.CENTER);
      label.setFont(label.getFont().deriveFont(Font.PLAIN, 18f));
      label.setBorder(BorderFactory.createEmptyBorder(24, 24, 12, 24));
      JButton button = new JButton("Click me");
      button.addActionListener(e -> {
        clicks++;
        label.setText("<html><center>Hello from webapp-anything!<br>Button clicked " + clicks + (clicks == 1 ? " time" : " times") + ".</center></html>");
      });
      frame.getContentPane().add(label, BorderLayout.CENTER);
      frame.getContentPane().add(button, BorderLayout.SOUTH);
      frame.setSize(480, 240);
      frame.setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE);
      frame.setLocationRelativeTo(null);
      frame.setVisible(true);
    });
  }
}
