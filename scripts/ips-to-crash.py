#!/usr/bin/env python3
"""
将 .ips JSON 格式的崩溃日志转换为 .crash 文本格式
用法: python3 ips-to-crash.py input.ips output.crash
"""

import json
import sys
import os

def convert_ips_to_crash(ips_file, crash_file):
    """转换 .ips 文件为 .crash 格式"""
    
    # 读取 .ips 文件
    with open(ips_file, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # .ips 文件可能是多行 JSON，每行一个 JSON 对象
    lines = content.strip().split('\n')
    
    # 找到包含完整崩溃数据的行
    crash_data = None
    for line in lines:
        try:
            data = json.loads(line)
            if 'threads' in data and 'binaryImages' in data:
                crash_data = data
                print(f"✓ 找到完整的崩溃数据（第 {lines.index(line) + 1} 行）")
                break
        except json.JSONDecodeError:
            continue
    
    if not crash_data:
        print("✗ 错误：未找到包含 threads 和 binaryImages 的完整崩溃数据")
        sys.exit(1)
    
    # 开始构建 .crash 格式的文本
    output_lines = []
    
    # 添加基本信息
    incident_id = crash_data.get('incident_id', crash_data.get('incidentID', 'N/A'))
    output_lines.append(f"Incident Identifier: {incident_id}")
    output_lines.append(f"CrashReporter Key:   {crash_data.get('crashReporterKey', 'N/A')}")
    output_lines.append(f"Hardware Model:      {crash_data.get('modelCode', crash_data.get('hardwareModel', 'N/A'))}")
    
    proc_name = crash_data.get('procName', crash_data.get('app_name', 'Unknown'))
    pid = crash_data.get('pid', '0')
    output_lines.append(f"Process:             {proc_name} [{pid}]")
    output_lines.append(f"Path:                {crash_data.get('procPath', crash_data.get('bundlePath', 'N/A'))}")
    output_lines.append(f"Identifier:          {crash_data.get('bundleID', 'N/A')}")
    
    app_version = crash_data.get('app_version', crash_data.get('bundleVersion', 'N/A'))
    build_version = crash_data.get('build_version', crash_data.get('bundleShortVersion', 'N/A'))
    output_lines.append(f"Version:             {app_version} ({build_version})")
    output_lines.append(f"Code Type:           {crash_data.get('cpuType', 'ARM-64')}")
    output_lines.append(f"Parent Process:      {crash_data.get('parentProc', 'launchd')} [{crash_data.get('parentPid', '1')}]")
    output_lines.append("")
    
    # 添加日期和系统信息
    output_lines.append(f"Date/Time:           {crash_data.get('timestamp', crash_data.get('captureTime', ''))}")
    
    os_version = crash_data.get('osVersion', {})
    if isinstance(os_version, dict):
        os_str = os_version.get('train', 'iOS')
        os_build = os_version.get('build', '')
        output_lines.append(f"OS Version:          {os_str} ({os_build})" if os_build else f"OS Version:          {os_str}")
    else:
        output_lines.append(f"OS Version:          {crash_data.get('os_version', 'iOS')}")
    
    output_lines.append("Report Version:      104")
    output_lines.append("")
    
    # 添加异常信息
    exception = crash_data.get('exception', {})
    if exception:
        exc_type = exception.get('type', 'EXC_CRASH')
        exc_signal = exception.get('signal', '')
        output_lines.append(f"Exception Type:      {exc_type} ({exc_signal})" if exc_signal else f"Exception Type:      {exc_type}")
        
        if 'codes' in exception:
            output_lines.append(f"Exception Codes:     {exception['codes']}")
        if 'subtype' in exception:
            output_lines.append(f"Exception Subtype:   {exception['subtype']}")
        output_lines.append("")
    
    # 找到崩溃的线程
    threads = crash_data.get('threads', [])
    crashed_thread_index = next((i for i, t in enumerate(threads) if t.get('triggered')), 0)
    output_lines.append(f"Crashed Thread:      {crashed_thread_index}")
    output_lines.append("")
    
    # 添加 Application Specific Information
    app_info = crash_data.get('appSpecificInfo', crash_data.get('applicationSpecificInformation'))
    if app_info:
        output_lines.append("Application Specific Information:")
        if isinstance(app_info, str):
            output_lines.append(app_info)
        elif isinstance(app_info, list):
            output_lines.extend(app_info)
        output_lines.append("")
    
    # 添加线程信息
    binary_images = crash_data.get('binaryImages', [])
    
    for thread_index, thread in enumerate(threads):
        if thread.get('triggered'):
            output_lines.append(f"Thread {thread_index} Crashed:")
        else:
            output_lines.append(f"Thread {thread_index}:")
        
        frames = thread.get('frames', [])
        for frame_index, frame in enumerate(frames[:50]):  # 限制每个线程最多50帧
            image_index = frame.get('imageIndex', 0)
            if image_index < len(binary_images):
                image_info = binary_images[image_index]
                
                # 提取二进制名称
                binary_name = image_info.get('name', 'Unknown')
                if '/' in binary_name:
                    binary_name = binary_name.split('/')[-1]
                
                # 计算地址
                load_address = image_info.get('base', image_info.get('loadAddress', 0))
                image_offset = frame.get('imageOffset', 0)
                actual_address = load_address + image_offset
                
                # 格式化地址
                address_str = f"0x{actual_address:016x}"
                load_addr_str = f"0x{load_address:x}"
                
                # 符号信息
                symbol = frame.get('symbol', f"{load_addr_str} + {image_offset}")
                
                output_lines.append(f"{frame_index}  {binary_name}  {address_str} {symbol}")
        
        output_lines.append("")
    
    # 添加 Binary Images
    output_lines.append("Binary Images:")
    for img in binary_images:
        base = img.get('base', img.get('loadAddress', 0))
        size = img.get('size', 0)
        end = base + size
        
        name = img.get('name', 'Unknown')
        if '/' in name:
            name = name.split('/')[-1]
        
        arch = img.get('arch', 'arm64')
        uuid = img.get('uuid', 'N/A')
        path = img.get('path', img.get('name', ''))
        
        output_lines.append(f"0x{base:09x} - 0x{end:09x} {name} {arch}  <{uuid}> {path}")
    
    # 写入输出文件
    with open(crash_file, 'w', encoding='utf-8') as f:
        f.write('\n'.join(output_lines))
    
    print(f"✓ 转换完成：{crash_file}")
    print(f"  - 线程数：{len(threads)}")
    print(f"  - 二进制镜像数：{len(binary_images)}")
    print(f"  - 崩溃线程：Thread {crashed_thread_index}")

if __name__ == '__main__':
    if len(sys.argv) != 3:
        print("用法: python3 ips-to-crash.py input.ips output.crash")
        print("示例: python3 ips-to-crash.py NNIM-2025-11-26.ips NNIM-2025-11-26.crash")
        sys.exit(1)
    
    input_file = sys.argv[1]
    output_file = sys.argv[2]
    
    if not os.path.exists(input_file):
        print(f"✗ 错误：文件不存在 - {input_file}")
        sys.exit(1)
    
    convert_ips_to_crash(input_file, output_file)
