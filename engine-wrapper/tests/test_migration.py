"""
Test for ZIP double-folder detection logic in launcher.py
"""

from pathlib import Path


def test_double_folder_detection_direct():
    """Test that direct shogihome folder is detected"""
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_path = Path(tmp_dir)
        # Create structure: tmp_path/shogihome/
        shogihome_dir = tmp_path / "shogihome"
        shogihome_dir.mkdir()

        # Simulate the detection logic
        old_dir = tmp_path

        # ZIP 展開時の 2 重フォルダ対策：shogihome がない場合、1 階層下を検索
        if not (old_dir / "shogihome").exists():
            for sub in old_dir.iterdir():
                if sub.is_dir() and (sub / "shogihome").exists():
                    old_dir = sub
                    break

        # Should remain the same (no search needed)
        assert old_dir == tmp_path


def test_double_folder_detection_nested():
    """Test that nested shogihome folder is detected (ZIP double-folder scenario)"""
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_path = Path(tmp_dir)
        # Create structure: tmp_path/extracted-folder/shogihome/
        extracted_dir = tmp_path / "extracted-folder"
        extracted_dir.mkdir()
        shogihome_dir = extracted_dir / "shogihome"
        shogihome_dir.mkdir()

        # Simulate the detection logic
        old_dir = tmp_path

        # ZIP 展開時の 2 重フォルダ対策：shogihome がない場合、1 階層下を検索
        if not (old_dir / "shogihome").exists():
            for sub in old_dir.iterdir():
                if sub.is_dir() and (sub / "shogihome").exists():
                    old_dir = sub
                    break

        # Should detect the nested folder
        assert old_dir == extracted_dir


def test_double_folder_detection_multiple_subdirs():
    """Test that correct folder is detected when multiple subdirectories exist"""
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_path = Path(tmp_dir)
        # Create structure: tmp_path/
        #   - docs/ (no shogihome)
        #   - shogihome-lan/shogihome/ (target)
        #   - backup/ (no shogihome)
        docs_dir = tmp_path / "docs"
        docs_dir.mkdir()

        target_dir = tmp_path / "shogihome-lan"
        target_dir.mkdir()
        shogihome_dir = target_dir / "shogihome"
        shogihome_dir.mkdir()

        backup_dir = tmp_path / "backup"
        backup_dir.mkdir()

        # Simulate the detection logic
        old_dir = tmp_path

        # ZIP 展開時の 2 重フォルダ対策：shogihome がない場合、1 階層下を検索
        if not (old_dir / "shogihome").exists():
            for sub in old_dir.iterdir():
                if sub.is_dir() and (sub / "shogihome").exists():
                    old_dir = sub
                    break

        # Should detect the correct folder
        assert old_dir == target_dir


def test_double_folder_detection_no_shogihome():
    """Test behavior when no shogihome folder is found"""
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_path = Path(tmp_dir)
        # Create structure: tmp_path/random-folder/ (no shogihome)
        random_dir = tmp_path / "random-folder"
        random_dir.mkdir()

        # Simulate the detection logic
        old_dir = tmp_path

        # ZIP 展開時の 2 重フォルダ対策：shogihome がない場合、1 階層下を検索
        if not (old_dir / "shogihome").exists():
            for sub in old_dir.iterdir():
                if sub.is_dir() and (sub / "shogihome").exists():
                    old_dir = sub
                    break

        # Should remain unchanged (no shogihome found)
        assert old_dir == tmp_path
        # Subsequent validation should fail (no shogihome exists)
        assert not (old_dir / "shogihome").exists()
