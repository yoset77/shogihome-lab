using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

namespace ShogiHomeLauncher
{
    static class Program
    {
        [STAThread]
        static void Main()
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string pythonPath = Path.Combine(baseDir, "python", "pythonw.exe");
            string launcherScript = Path.Combine(baseDir, "engine-wrapper", "launcher.py");

            if (!File.Exists(pythonPath))
            {
                MessageBox.Show("Could not find the Python executable at:\n" + pythonPath, "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            if (!File.Exists(launcherScript))
            {
                MessageBox.Show("Could not find the launcher script at:\n" + launcherScript, "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = pythonPath;
            startInfo.Arguments = "\"" + launcherScript + "\"";
            startInfo.WorkingDirectory = baseDir;
            startInfo.UseShellExecute = false;
            startInfo.CreateNoWindow = true;

            try
            {
                Process.Start(startInfo);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Failed to start ShogiHome LAN:\n" + ex.Message, "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }
}
