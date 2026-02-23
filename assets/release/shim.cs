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
            string launcherPath = Path.Combine(baseDir, "engine-wrapper");
            launcherPath = Path.Combine(launcherPath, "launcher.exe");

            if (!File.Exists(launcherPath))
            {
                MessageBox.Show("Could not find the launcher executable at:\n" + launcherPath, "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = launcherPath;
            startInfo.WorkingDirectory = baseDir;
            startInfo.UseShellExecute = false;

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
